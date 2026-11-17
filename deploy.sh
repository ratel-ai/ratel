#!/bin/sh
# Deploys the self-hosted Ratel Platform to a new VM in your cloud, from your laptop.
#
#   curl -fsSL https://raw.githubusercontent.com/ratel-ai/ratel/main/deploy.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/ratel-ai/ratel/main/deploy.sh | sh -s -- status
#   curl -fsSL https://raw.githubusercontent.com/ratel-ai/ratel/main/deploy.sh | sh -s -- destroy
#
# It finds the cloud you are logged in to (AWS, Google Cloud, Azure, DigitalOcean or Hetzner),
# creates one VM with OpenTofu or Terraform, and installs Ratel on it with install.sh. Run `up`
# again to upgrade the VM to a new --ref. State and secrets stay on this machine, in
# ~/.ratel/deploy/<name>/. See README.md "Deploy to your cloud".
set -eu

RATEL_RAW_URL="${RATEL_RAW_URL:-https://raw.githubusercontent.com/ratel-ai/ratel}"
RATEL_DEPLOY_HOME="${RATEL_DEPLOY_HOME:-$HOME/.ratel/deploy}"
CLOUDS="aws gcp azure digitalocean hetzner"
# deploy/terraform/<cloud>/ and deploy/terraform/cloud-init/: what a download fetches.
MODULE_FILES="main.tf variables.tf outputs.tf"
SHARED_FILES="main.tf cloud-init.yaml.tftpl"
SSH_USER=ratel
# install.sh's login user in the public mode.
CONSOLE_USER=ratel
INSTALL_DIR=/opt/ratel
# The install takes about 5 minutes on 2 vCPU. Certificates can take a minute more.
HEALTH_TRIES=60

# The settings. parse_args sets the flags; a new deploy fills the rest with apply_defaults, an
# existing one reads them from its state.
COMMAND=""
NAME=ratel
CLOUD=""
REGION=""
SIZE=""
REF=""
ACCESS=""
DOMAIN=""
ALLOW_CIDRS=""
IAC=""
ASSUME_YES=0
ENGINE=""
PROJECT=""
MY_IP=""
APPLIED=""
STATE=""
TF_ROOT=""
IP=""
SITE=""
URL=""

main() {
  parse_args "$@"
  STATE="$RATEL_DEPLOY_HOME/$NAME"
  TF_ROOT="$STATE/tf"
  say "Ratel cloud deploy"
  case "$COMMAND" in
    up) if deployed; then upgrade; else create; fi ;;
    status) status ;;
    destroy) destroy ;;
  esac
}

# --- Arguments ---------------------------------------------------------------------------------

# Leaves every setting that has a default empty: apply_defaults fills them for a new deploy, and
# a rerun on an existing deploy can tell a flag from a default.
parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      up | status | destroy)
        [ -z "$COMMAND" ] || usage_error "one command only: $COMMAND or $1"
        COMMAND=$1
        ;;
      --cloud | --region | --size | --name | --ref | --access | --domain | --allow-cidr | --iac)
        [ $# -ge 2 ] || usage_error "$1 needs a value"
        set_flag "${1#--}" "$2"
        shift
        ;;
      --cloud=* | --region=* | --size=* | --name=* | --ref=* | --access=* | --domain=* | --allow-cidr=* | --iac=*)
        flag=${1%%=*}
        set_flag "${flag#--}" "${1#*=}"
        ;;
      -y | --yes) ASSUME_YES=1 ;;
      -h | --help) usage; exit 0 ;;
      *) usage_error "unknown argument: $1" ;;
    esac
    shift
  done
  [ -n "$COMMAND" ] || COMMAND=up
}

# Every value ends up in an HCL file, a shell command on the VM or a Caddyfile, so each one is
# held to the characters its kind needs.
set_flag() {
  case "$1" in
    cloud)
      case " $CLOUDS " in *" $2 "*) CLOUD=$2 ;; *) usage_error "--cloud is one of: $CLOUDS" ;; esac
      ;;
    region) check_word "$1" "$2"; REGION=$2 ;;
    size) check_word "$1" "$2"; SIZE=$2 ;;
    ref) check_word "$1" "$2"; REF=$2 ;;
    name)
      printf '%s' "$2" | grep -Eq '^[a-z]([a-z0-9-]{0,18}[a-z0-9])?$' ||
        usage_error "--name is 1 to 20 lowercase letters, digits and dashes, and starts with a letter"
      NAME=$2
      ;;
    access)
      case "$2" in public | private) ACCESS=$2 ;; *) usage_error "--access is public or private" ;; esac
      ;;
    domain)
      printf '%s' "$2" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$' ||
        usage_error "--domain is not a host name: $2"
      DOMAIN=$2
      ;;
    allow-cidr)
      printf '%s' "$2" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$' ||
        usage_error "--allow-cidr is an IPv4 range such as 10.0.0.0/8: $2"
      ALLOW_CIDRS="${ALLOW_CIDRS:+$ALLOW_CIDRS }$2"
      ;;
    iac)
      case "$2" in terraform | tofu) IAC=$2 ;; *) usage_error "--iac is terraform or tofu" ;; esac
      ;;
  esac
}

check_word() {
  printf '%s' "$2" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._/-]*$' || usage_error "--$1 has characters it cannot have: $2"
}

usage() {
  cat <<'EOF'
Usage: deploy.sh [up|status|destroy] [options]

  up        create the VM and install Ratel (default). On an existing deploy: upgrade it.
  status    print the address and whether Ratel answers
  destroy   delete the VM, its disk and its IP

  --cloud       aws, gcp, azure, digitalocean or hetzner (default: the one you are logged in to)
  --region      the cloud's region (default: your CLI's region, or a common one)
  --size        the VM type (default: 2 vCPU or more, 8 GB RAM)
  --name        the deploy's name, for several deploys (default: ratel)
  --ref         the branch, tag or commit to install (default: main)
  --access      public: HTTPS with a login on 80 and 443 (default)
                private: no web port, reach it with an SSH tunnel
  --domain      public: your DNS name for the VM (default: <ip>.sslip.io)
  --allow-cidr  public: open 80 and 443 only to this range; private: also open SSH to it.
                Repeat it for more ranges.
  --iac         tofu or terraform (default: tofu if installed)
  --yes         ask nothing
EOF
}

usage_error() {
  printf 'deploy.sh: %s\n' "$1" >&2
  usage >&2
  exit 2
}

# The defaults of a new deploy. The region comes from the cloud's CLI when it has one set.
apply_defaults() {
  [ -n "$ACCESS" ] || ACCESS=public
  [ -n "$REF" ] || REF=main
  [ -n "$REGION" ] || REGION=$(cli_region "$CLOUD")
  if [ -z "$REGION" ]; then
    case "$CLOUD" in
      aws) REGION=us-east-1 ;;
      gcp) REGION=us-central1 ;;
      azure) REGION=eastus ;;
      digitalocean) REGION=nyc3 ;;
      hetzner) REGION=nbg1 ;;
    esac
  fi
  if [ -z "$SIZE" ]; then
    case "$CLOUD" in
      aws) SIZE=t3.large ;;
      gcp) SIZE=e2-standard-2 ;;
      azure) SIZE=Standard_B2ms ;;
      digitalocean) SIZE=s-4vcpu-8gb ;;
      hetzner) SIZE=cx33 ;;
    esac
  fi
}

cli_region() {
  case "$1" in
    aws)
      region="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"
      [ -n "$region" ] || ! have aws || region=$(aws configure get region 2>/dev/null || true)
      ;;
    gcp) region=$(have gcloud && gcloud config get-value compute/region 2>/dev/null || true) ;;
    *) region="" ;;
  esac
  printf '%s' "$region" | grep -E '^[a-z0-9-]+$' || true
}

# --- up: a new deploy --------------------------------------------------------------------------

create() {
  # A run stopped at the question, or a failed apply, left state: keep its cloud.
  if [ -f "$STATE/config" ]; then
    saved=$(config_get CLOUD)
    [ -z "$CLOUD" ] || [ "$CLOUD" = "$saved" ] ||
      fail "The deploy $NAME has state on $saved. Run deploy.sh destroy$(name_flag) first, or use --name."
    CLOUD=$saved
  fi
  step "Cloud"
  choose_cloud
  step "Engine"
  choose_engine
  apply_defaults
  [ "$CLOUD" != gcp ] || PROJECT=$(gcloud config get-value project 2>/dev/null)
  MY_IP=$(caller_ip) || fail "Cannot find this machine's public IP, which SSH is opened to."

  step "Deploy"
  info "Name:     $NAME"
  info "Cloud:    $CLOUD, region $REGION"
  info "Size:     $SIZE"
  info "Access:   $(describe_access)"
  info "Ref:      $REF"
  info "State:    $STATE"
  init_state
  stage_modules "$(module_source)"
  save_config
  write_tfvars "$(tf_dir)/terraform.tfvars"

  step "Plan"
  cloud_env
  tf_quiet init "$STATE/init.log" -input=false
  tf_quiet plan "$STATE/plan.log" -input=false -out=tfplan -no-color
  plan_summary "$STATE/plan.log"
  info ""
  print_costs "$CLOUD" "$SIZE"
  info ""
  confirm "Create these resources in $CLOUD? They cost money until you run deploy.sh destroy." ||
    { info "Nothing was created. Run the same command again to deploy."; exit 0; }

  step "Apply"
  tf apply -input=false tfplan
  rm -f "$(tf_dir)/tfplan"
  chmod 600 "$(tf_dir)"/terraform.tfstate* 2>/dev/null || true
  # shellcheck disable=SC2034 # save_config reads it by name.
  APPLIED=1
  save_config
  read_outputs
  if [ "$ACCESS" = public ]; then
    save_credentials "$URL" "$CONSOLE_USER" "$(tf output -raw password)"
  fi

  step "Install"
  wait_for_ssh
  follow_install
  wait_for_health
  print_result new
}

# Finds the logged-in clouds. One is used as it is. Several mean a question, or --cloud with
# --yes. None means the login commands.
choose_cloud() {
  found=$(detect_clouds)
  for cloud in $CLOUDS; do
    line=$(printf '%s\n' "$found" | grep "^$cloud " || true)
    if [ -n "$line" ]; then ok "$cloud: ${line#* }"; else info "- $cloud: not logged in"; fi
  done

  if [ -n "$CLOUD" ]; then
    printf '%s\n' "$found" | grep -q "^$CLOUD " || {
      warn "You are not logged in to $CLOUD."
      login_hint "$CLOUD"
      exit 1
    }
  else
    names=$(printf '%s\n' "$found" | cut -d' ' -f1 | tr '\n' ' ' | sed 's/ *$//')
    count=$(printf '%s\n' "$found" | grep -c . || true)
    if [ "$count" = 0 ]; then
      warn "No cloud login found. Log in to one, then run deploy.sh again:"
      for cloud in $CLOUDS; do login_hint "$cloud"; done
      exit 1
    elif [ "$count" = 1 ]; then
      CLOUD=$names
    elif [ "$ASSUME_YES" = 1 ] || ! has_tty; then
      fail "You are logged in to several clouds ($names). Pass --cloud to choose one."
    else
      i=0
      for cloud in $names; do i=$((i + 1)); info "  $i) $cloud"; done
      choice=$(ask "Which cloud? [1-$count]")
      case "$choice" in "" | *[!0-9]*) choice=0 ;; esac
      # shellcheck disable=SC2086
      CLOUD=$(printf '%s\n' $names | sed -n "${choice}p")
      [ -n "$CLOUD" ] || fail "No cloud chosen. Pass --cloud to choose one."
    fi
  fi
  info "Using $CLOUD."
}

# Prints "<cloud> <who>" for each cloud with a login, in the order of CLOUDS. Tokens stay unprinted.
detect_clouds() {
  for cloud in $CLOUDS; do
    who=$(cloud_identity "$cloud" 2>/dev/null) && [ -n "$who" ] && printf '%s %s\n' "$cloud" "$who"
  done
  return 0
}

cloud_identity() {
  case "$1" in
    aws)
      have aws || return 1
      account=$(aws sts get-caller-identity --query Account --output text) || return 1
      echo "account $account"
      ;;
    gcp)
      have gcloud || return 1
      account=$(gcloud config get-value account)
      project=$(gcloud config get-value project)
      [ -n "$account" ] && [ -n "$project" ] || return 1
      echo "$account, project $project"
      ;;
    azure)
      have az || return 1
      subscription=$(az account show --query name -o tsv) || return 1
      echo "subscription $subscription"
      ;;
    digitalocean)
      if [ -n "${DIGITALOCEAN_TOKEN:-}" ]; then echo DIGITALOCEAN_TOKEN; return 0; fi
      have doctl || return 1
      email=$(doctl account get --format Email --no-header) || return 1
      echo "doctl, $email"
      ;;
    hetzner)
      if [ -n "${HCLOUD_TOKEN:-}" ]; then echo HCLOUD_TOKEN; return 0; fi
      have hcloud || return 1
      context=$(hcloud context active) || return 1
      [ -n "$context" ] || return 1
      echo "hcloud context $context"
      ;;
  esac
}

login_hint() {
  case "$1" in
    aws) info "  aws:          aws login   (or: aws configure sso)" ;;
    gcp) info "  gcp:          gcloud auth login && gcloud config set project <project-id>" ;;
    azure) info "  azure:        az login" ;;
    digitalocean) info "  digitalocean: export DIGITALOCEAN_TOKEN=<token>   (or: doctl auth init)" ;;
    hetzner) info "  hetzner:      export HCLOUD_TOKEN=<token>   (or: hcloud context create ratel)" ;;
  esac
}

# OpenTofu or Terraform: --iac, else tofu when installed, else terraform.
choose_engine() {
  if [ -n "$IAC" ]; then
    have "$IAC" || { warn "$IAC is not installed."; engine_hint "$IAC"; exit 1; }
    ENGINE=$IAC
  elif have tofu; then
    ENGINE=tofu
  elif have terraform; then
    ENGINE=terraform
  else
    warn "deploy.sh needs OpenTofu or Terraform. Install one, then run deploy.sh again:"
    engine_hint tofu
    exit 1
  fi
  ok "$ENGINE $("$ENGINE" version 2>/dev/null | head -n 1 | sed 's/^[^v]*//')"
}

engine_hint() {
  if [ "$1" = terraform ]; then
    info "  macOS: brew tap hashicorp/tap && brew install hashicorp/tap/terraform"
    info "  Linux: https://developer.hashicorp.com/terraform/install"
  else
    info "  macOS: brew install opentofu"
    info "  Linux: curl -fsSL https://get.opentofu.org/install-opentofu.sh | sh -s -- --install-method standalone"
    info "  Other: https://opentofu.org/docs/intro/install/"
  fi
}

# The IPv4 address this machine reaches the internet from. SSH is opened to it only.
caller_ip() {
  for url in https://checkip.amazonaws.com https://api.ipify.org https://ifconfig.me/ip; do
    ip=$(curl -4 -fsS --max-time 5 "$url" 2>/dev/null | tr -d ' \r\n' || true)
    if printf '%s' "$ip" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$'; then
      echo "$ip"
      return 0
    fi
  done
  return 1
}

describe_access() {
  if [ "$ACCESS" = private ]; then
    echo "private (SSH tunnel only)"
  elif [ -n "$ALLOW_CIDRS" ]; then
    echo "public, HTTPS with a login, open to $ALLOW_CIDRS, Caddy's own CA"
  else
    echo "public, HTTPS with a login, at ${DOMAIN:-<ip>.sslip.io}"
  fi
}

# --- State -------------------------------------------------------------------------------------

# ~/.ratel/deploy/<name>/ (700) holds the SSH key, the settings, the Terraform state and the
# console password. Nothing in it leaves this machine but the public key.
init_state() {
  (umask 077 && mkdir -p "$STATE")
  chmod 700 "$STATE"
  if [ ! -f "$STATE/id_ed25519" ]; then
    ssh-keygen -q -t ed25519 -N "" -C "ratel-deploy-${NAME:-ratel}" -f "$STATE/id_ed25519"
  fi
  chmod 600 "$STATE/id_ed25519"
}

save_config() {
  (
    umask 077
    {
      for key in CLOUD ENGINE REGION SIZE ACCESS DOMAIN ALLOW_CIDRS REF PROJECT MY_IP APPLIED; do
        eval "value=\${$key:-}"
        printf '%s=%s\n' "$key" "$value"
      done
    } >"$STATE/config"
  )
}

# Reads one setting back. The file is never sourced, so it cannot run anything.
config_get() {
  sed -n "s/^$1=//p" "$STATE/config" 2>/dev/null | tail -n 1
}

load_config() {
  [ -f "$STATE/config" ] || fail "No deploy named $NAME. Run: deploy.sh up${NAME:+ --name $NAME}"
  saved=$(config_get CLOUD)
  [ -z "$CLOUD" ] || [ "$CLOUD" = "$saved" ] ||
    fail "The deploy $NAME is on $saved, not $CLOUD. Use --name for a second deploy."
  CLOUD=$saved
  ENGINE=$(config_get ENGINE)
  have "$ENGINE" || { warn "$ENGINE made this deploy, and it is not installed now."; engine_hint "$ENGINE"; exit 1; }
  REGION=$(config_get REGION)
  SIZE=$(config_get SIZE)
  ACCESS=$(config_get ACCESS)
  DOMAIN=$(config_get DOMAIN)
  ALLOW_CIDRS=$(config_get ALLOW_CIDRS)
  PROJECT=$(config_get PROJECT)
  MY_IP=$(config_get MY_IP)
}

save_credentials() {
  (umask 077 && printf 'url=%s\nuser=%s\npassword=%s\n' "$1" "$2" "$3" >"$STATE/credentials")
}

# True after an apply that succeeded. A run stopped at the question, or a failed apply, is not
# deployed: `up` plans and applies again.
deployed() {
  [ "$(config_get APPLIED)" = 1 ]
}

tf_dir() {
  echo "$TF_ROOT/$CLOUD"
}

# The modules come from this checkout when deploy.sh runs from one, else from GitHub at --ref.
module_source() {
  if [ -n "${RATEL_DEPLOY_MODULES:-}" ]; then
    echo "$RATEL_DEPLOY_MODULES"
    return 0
  fi
  case "$0" in
    */deploy.sh | deploy.sh)
      dir=$(cd "$(dirname "$0")" && pwd)
      if [ -d "$dir/deploy/terraform/$CLOUD" ]; then
        echo "$dir/deploy/terraform"
        return 0
      fi
      ;;
  esac
  echo "$RATEL_RAW_URL/$REF/deploy/terraform"
}

# Copies (or downloads) deploy/terraform/<cloud>/ and deploy/terraform/cloud-init/ into the
# state, so the state keeps the exact code that made the VM.
stage_modules() {
  mkdir -p "$TF_ROOT/cloud-init" "$TF_ROOT/$CLOUD"
  for file in $SHARED_FILES; do fetch_module_file "$1" "cloud-init/$file"; done
  for file in $MODULE_FILES; do fetch_module_file "$1" "$CLOUD/$file"; done
}

fetch_module_file() {
  case "$1" in
    http://* | https://*) curl -fsSL "$1/$2" -o "$TF_ROOT/$2" || fail "Cannot download $1/$2" ;;
    *) cp "$1/$2" "$TF_ROOT/$2" ;;
  esac
}

# The module inputs. Public: 80 and 443 to all, or to --allow-cidr only (then Let's Encrypt
# cannot reach port 80, so Caddy uses its own CA). SSH: this machine's IP, plus --allow-cidr in
# private mode.
write_tfvars() {
  ssh_cidrs="$MY_IP/32"
  web_cidrs=""
  tls=acme
  if [ "$ACCESS" = public ]; then
    web_cidrs=${ALLOW_CIDRS:-0.0.0.0/0}
    [ -z "$ALLOW_CIDRS" ] || tls=internal
  else
    ssh_cidrs="$ssh_cidrs${ALLOW_CIDRS:+ $ALLOW_CIDRS}"
  fi
  (
    umask 077
    {
      printf 'name = "%s"\n' "$NAME"
      printf 'region = "%s"\n' "$REGION"
      printf 'size = "%s"\n' "$SIZE"
      printf 'ssh_public_key = "%s"\n' "$(cat "$STATE/id_ed25519.pub")"
      printf 'ssh_cidrs = %s\n' "$(hcl_list "$ssh_cidrs")"
      printf 'web_cidrs = %s\n' "$(hcl_list "$web_cidrs")"
      printf 'access = "%s"\n' "$ACCESS"
      printf 'domain = "%s"\n' "$DOMAIN"
      printf 'tls = "%s"\n' "$tls"
      printf 'ref = "%s"\n' "$REF"
      printf 'install_url = "%s"\n' "$RATEL_RAW_URL/$REF/install.sh"
      [ "$CLOUD" != gcp ] || printf 'project = "%s"\n' "$PROJECT"
    } >"$1"
  )
}

hcl_list() {
  list=""
  for item in $1; do list="${list:+$list, }\"$item\""; done
  echo "[$list]"
}

# --- Engine ------------------------------------------------------------------------------------

tf() {
  (cd "$(tf_dir)" && "$ENGINE" "$@")
}

# Runs an engine command into a log, and prints the log's end only when it fails.
tf_quiet() {
  command=$1
  log=$2
  shift 2
  info "$ENGINE $command"
  if ! tf "$command" "$@" >"$log" 2>&1; then
    tail -n 30 "$log" >&2
    fail "$ENGINE $command failed. The full output is in $log"
  fi
}

# The credentials each provider reads, taken from the CLI the user is logged in with.
cloud_env() {
  case "$CLOUD" in
    gcp)
      if [ -z "${GOOGLE_OAUTH_ACCESS_TOKEN:-}" ] && [ -z "${GOOGLE_APPLICATION_CREDENTIALS:-}" ]; then
        GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token 2>/dev/null) ||
          fail "gcloud cannot print an access token. Run: gcloud auth login"
        export GOOGLE_OAUTH_ACCESS_TOKEN
      fi
      ;;
    azure)
      [ -n "${ARM_SUBSCRIPTION_ID:-}" ] || ARM_SUBSCRIPTION_ID=$(az account show --query id -o tsv)
      export ARM_SUBSCRIPTION_ID
      ;;
    digitalocean)
      [ -n "${DIGITALOCEAN_TOKEN:-}" ] || DIGITALOCEAN_TOKEN=$(doctl_token)
      [ -n "$DIGITALOCEAN_TOKEN" ] || fail "Set DIGITALOCEAN_TOKEN: doctl's token was not found."
      export DIGITALOCEAN_TOKEN
      ;;
    hetzner)
      [ -n "${HCLOUD_TOKEN:-}" ] || HCLOUD_TOKEN=$(hcloud_token)
      [ -n "$HCLOUD_TOKEN" ] || fail "Set HCLOUD_TOKEN: the hcloud context's token was not found."
      export HCLOUD_TOKEN
      ;;
  esac
}

doctl_token() {
  for file in "${XDG_CONFIG_HOME:-$HOME/.config}/doctl/config.yaml" "$HOME/Library/Application Support/doctl/config.yaml"; do
    [ -f "$file" ] && sed -n 's/^access-token: *//p' "$file" | head -n 1 && return 0
  done
  return 0
}

hcloud_token() {
  file="${XDG_CONFIG_HOME:-$HOME/.config}/hcloud/cli.toml"
  [ -f "$file" ] || return 0
  context=$(hcloud context active 2>/dev/null || true)
  awk -v want="$context" '
    /^[[:space:]]*name[[:space:]]*=/ { v = $0; sub(/^[^"]*"/, "", v); sub(/".*$/, "", v); name = v }
    /^[[:space:]]*token[[:space:]]*=/ && name == want { v = $0; sub(/^[^"]*"/, "", v); sub(/".*$/, "", v); print v; exit }
  ' "$file"
}

# The resource lines and the totals of a plan, without the attributes.
plan_summary() {
  sed -n -e 's/^  # \(.*\) will be created$/    + \1/p' \
    -e 's/^  # \(.*\) will be updated in-place$/    ~ \1/p' \
    -e 's/^  # \(.*\) must be replaced$/    -\/+ \1/p' \
    -e 's/^  # \(.*\) will be destroyed$/    - \1/p' \
    -e 's/^\(Plan: .*\)$/    \1/p' \
    -e 's/^\(No changes\..*\)$/    \1/p' "$1"
}

# A rough monthly price per size: on-demand compute in a common region, before disk, IP and
# traffic, which add a few dollars. The cloud's own price page is the reference.
print_costs() {
  info "Estimated monthly cost (compute only, on-demand, rough; disk, IP and traffic add a little):"
  found=0
  while read -r size cpus ram usd; do
    marker=" "
    [ "$size" = "$2" ] && { marker=">"; found=1; }
    printf '    %s %-16s %2s vCPU %3s GB  ~US$%-4s %s\n' "$marker" "$size" "$cpus" "$ram" "$usd" "$(cost_class "$usd")"
  done <<EOF
$(size_catalog "$1")
EOF
  [ "$found" = 1 ] || info "  $2: not in this list. See the cloud's price page."
}

# size vCPU RAM(GB) USD/month
size_catalog() {
  case "$1" in
    aws) printf '%s\n' "t3.large 2 8 61" "m7i.large 2 8 74" "t3.xlarge 4 16 121" ;;
    gcp) printf '%s\n' "e2-standard-2 2 8 49" "n2-standard-2 2 8 71" "e2-standard-4 4 16 98" ;;
    azure) printf '%s\n' "Standard_B2ms 2 8 61" "Standard_D2s_v5 2 8 70" "Standard_B4ms 4 16 121" ;;
    digitalocean) printf '%s\n' "s-4vcpu-8gb 4 8 48" "g-2vcpu-8gb 2 8 63" "s-8vcpu-16gb 8 16 96" ;;
    hetzner) printf '%s\n' "cx33 4 8 10" "cpx32 4 8 42" "ccx13 2 8 50" ;;
  esac
}

cost_class() {
  if [ "$1" -lt 20 ]; then echo '$'; elif [ "$1" -lt 80 ]; then echo '$$'; else echo '$$$'; fi
}

read_outputs() {
  IP=$(tf output -raw public_ip)
  SITE=$(tf output -raw domain)
  URL=$(tf output -raw url)
}

# --- On the VM ---------------------------------------------------------------------------------

remote() {
  ssh -i "$STATE/id_ed25519" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new \
    -o UserKnownHostsFile="$STATE/known_hosts" -o ConnectTimeout=10 -o ServerAliveInterval=15 \
    -o LogLevel=ERROR "$SSH_USER@$IP" "$@"
}

wait_for_ssh() {
  info "Waiting for SSH on $IP"
  i=0
  until remote true 2>/dev/null; do
    i=$((i + 1))
    [ "$i" -lt 60 ] || fail "SSH on $IP did not answer in 5 minutes."
    sleep 5
  done
  ok "SSH"
}

# Streams the install's output from cloud-init until cloud-init is done.
follow_install() {
  info "Following the install on the VM (cloud-init runs install.sh, about 5 minutes)."
  # The ratel user is in the adm group, which reads the log. Single quotes: it runs on the VM.
  # shellcheck disable=SC2016
  if remote 'tail -n +1 -F /var/log/cloud-init-output.log 2>/dev/null & t=$!
    cloud-init status --wait >/dev/null; s=$?; sleep 2; kill $t; exit $s'; then
    ok "cloud-init done"
  else
    warn "cloud-init reported a problem. Read it with: $(ssh_command) sudo cat /var/log/cloud-init-output.log"
  fi
}

# Public: through Caddy, as a user would. Private: on the VM, through SSH.
wait_for_health() {
  i=0
  until health >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -lt "$HEALTH_TRIES" ] || fail "Ratel did not answer on /api/health in 5 minutes. Run: deploy.sh status${NAME:+ --name $NAME}"
    sleep 5
  done
  ok "Healthy: $(health_target)"
}

health() {
  if [ "$ACCESS" = public ] && [ -n "$ALLOW_CIDRS" ]; then
    # Caddy's own CA is not in this machine's trust store.
    curl -fsS --max-time 5 --insecure "$URL/api/health"
  elif [ "$ACCESS" = public ]; then
    curl -fsS --max-time 5 "$URL/api/health"
  else
    remote curl -fsS --max-time 5 http://127.0.0.1:3000/api/health
  fi
}

health_target() {
  if [ "$ACCESS" = public ]; then echo "$URL/api/health"; else echo "http://127.0.0.1:3000/api/health on the VM"; fi
}

ssh_command() {
  echo "ssh -i $STATE/id_ed25519 $SSH_USER@$IP"
}

print_result() {
  step "Ratel is running"
  if [ "$ACCESS" = public ]; then
    info "Open:     $URL"
    info "User:     $(sed -n 's/^user=//p' "$STATE/credentials")"
    if [ "$1" = new ]; then
      info "Password: $(sed -n 's/^password=//p' "$STATE/credentials")"
      info "          Shown once. It is also in $STATE/credentials (only you can read it)."
    else
      info "Password: in $STATE/credentials"
    fi
    [ -z "$ALLOW_CIDRS" ] || info "TLS:      Caddy's own CA, so the browser warns until you trust it."
    info ""
    info "The SDKs and MCP clients use project API keys on /v1, /v2, /api/v1, /api/v2 and"
    info "/api/mcp, which pass without the login."
  else
    info "The console has no login, so no web port is open. Tunnel to it:"
    info "  ssh -i $STATE/id_ed25519 -N -L 3000:127.0.0.1:3000 $SSH_USER@$IP"
    info "then open http://localhost:3000"
  fi
  info ""
  info "SSH:      $(ssh_command)"
  info "Status:   deploy.sh status$(name_flag)"
  info "Upgrade:  deploy.sh up$(name_flag) --ref <branch|tag|sha>"
  info "Destroy:  deploy.sh destroy$(name_flag)"
}

name_flag() {
  [ "$NAME" = ratel ] || printf ' --name %s' "$NAME"
}

# --- up: an existing deploy --------------------------------------------------------------------

# Reruns install.sh on the VM with the new --ref. The VM keeps its access mode. When this
# machine's IP changed, the firewall follows it first.
upgrade() {
  given_ref=$REF
  for flag in REGION SIZE ACCESS DOMAIN ALLOW_CIDRS IAC; do
    eval "value=\${$flag:-}"
    [ -z "$value" ] || warn "--$(echo "$flag" | tr 'A-Z_' 'a-z-') does not change an existing deploy. Destroy it and deploy again to change it."
  done
  load_config
  REF=${given_ref:-$(config_get REF)}
  step "Upgrade"
  info "Deploy:   $NAME on $CLOUD ($REGION)"
  info "Ref:      $REF"
  cloud_env
  read_outputs

  ip=$(caller_ip) || fail "Cannot find this machine's public IP."
  if [ "$ip" != "$MY_IP" ]; then
    info "Your IP changed ($MY_IP to $ip). SSH opens to the new one."
    MY_IP=$ip
    write_tfvars "$(tf_dir)/terraform.tfvars"
    tf_quiet plan "$STATE/plan.log" -input=false -out=tfplan -no-color
    plan_summary "$STATE/plan.log"
    confirm "Apply this firewall change?" || fail "SSH stays closed to this IP. Nothing was changed."
    tf apply -input=false tfplan
    rm -f "$(tf_dir)/tfplan"
  fi

  wait_for_ssh
  confirm "Upgrade Ratel on $IP to $REF?" || { info "Nothing was changed."; exit 0; }
  remote "curl -fsSL '$RATEL_RAW_URL/$REF/install.sh' | sudo sh -s -- --yes --ref '$REF' --dir $INSTALL_DIR" ||
    fail "install.sh failed on the VM. The output is above."
  save_config
  wait_for_health
  print_result upgrade
}

# --- status and destroy ------------------------------------------------------------------------

status() {
  load_config
  cloud_env
  if ! deployed; then
    info "The deploy $NAME has no resources. Run: deploy.sh up$(name_flag)"
    exit 0
  fi
  read_outputs
  step "Deploy $NAME"
  info "Cloud:    $CLOUD, region $REGION, size $SIZE"
  info "IP:       $IP"
  info "Access:   $(describe_access | sed "s/<ip>.sslip.io/$SITE/")"
  info "Ref:      $(config_get REF)"
  if health >/dev/null 2>&1; then ok "Healthy: $(health_target)"; else warn "Not answering: $(health_target)"; fi
  if [ "$ACCESS" = public ]; then
    info "Open:     $URL (user and password in $STATE/credentials)"
  else
    info "Tunnel:   ssh -i $STATE/id_ed25519 -N -L 3000:127.0.0.1:3000 $SSH_USER@$IP"
  fi
  info "SSH:      $(ssh_command)"
}

destroy() {
  load_config
  cloud_env
  if deployed; then
    read_outputs
    warn "This deletes the VM $NAME on $CLOUD ($IP), its disk with all Ratel data, and its IP."
    info "Back up first: $(ssh_command) 'cd $INSTALL_DIR && sudo docker compose exec -T db pg_dump -U ratel ratel' > ratel.sql"
    confirm "Destroy $NAME?" || { info "Nothing was deleted."; exit 0; }
    step "Destroy"
    tf destroy -input=false -auto-approve
  fi
  rm -rf "$STATE"
  ok "Deleted $NAME and its local state."
}

# --- Helpers -----------------------------------------------------------------------------------

have() {
  command -v "$1" >/dev/null 2>&1
}

has_tty() {
  [ -z "${RATEL_NO_TTY:-}" ] && (: </dev/tty) 2>/dev/null
}

# Asks on the terminal, since stdin is the script under `curl | sh`.
ask() {
  printf '%s ' "$1" >/dev/tty
  read -r answer </dev/tty || answer=""
  echo "$answer"
}

# No terminal and no --yes means no.
confirm() {
  [ "$ASSUME_YES" = 1 ] && return 0
  has_tty || { warn "$1 No terminal to ask on. Pass --yes to accept."; return 1; }
  case "$(ask "$1 [y/N]")" in y | Y | yes | YES) return 0 ;; *) return 1 ;; esac
}

say() { printf '\033[1m%s\033[0m\n' "$1"; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
info() { printf '    %s\n' "$1"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1" >&2; }
fail() {
  printf '  \033[31m✗\033[0m %s\n' "$1" >&2
  exit 1
}

# Everything above only defines functions, so a download cut short runs nothing.
[ "${RATEL_DEPLOY_SOURCE_ONLY:-}" = 1 ] || main "$@"
