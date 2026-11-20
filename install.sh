#!/bin/sh
# Installs or upgrades the self-hosted Ratel Platform with Docker Compose.
#
#   curl -fsSL https://raw.githubusercontent.com/ratel-ai/ratel/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/ratel-ai/ratel/main/install.sh | sh -s -- --yes --demo
#
# Options (each also reads an environment variable):
#   --ref <branch|tag|sha>  RATEL_REF   what to check out (default: main)
#   --dir <path>            RATEL_DIR   where to put it (default: ~/ratel, or /opt/ratel as root)
#   --yes, -y               RATEL_YES=1 answer yes to every question (for scripts)
#   --demo                  RATEL_DEMO=1 load the demo data after the start
#   --access private|public RATEL_ACCESS  private (default): ports stay on 127.0.0.1.
#                                         public: Caddy on 80 and 443, with TLS and a login.
#   --domain <name>         RATEL_DOMAIN  public: the site name (default: <public-ip>.sslip.io)
#   --tls acme|internal     RATEL_TLS     public: Let's Encrypt (default) or Caddy's own CA
#   --auth-hash <bcrypt>    RATEL_AUTH_HASH public: the login's hash (default: a new password,
#                                         printed once)
#
# Run it again to upgrade: it fetches the ref, rebuilds and restarts. It keeps the values in an
# existing .env and stops if the checkout has local changes. A rerun keeps the access settings.
set -eu

RATEL_REPO="${RATEL_REPO:-https://github.com/ratel-ai/ratel.git}"
RATEL_METADATA_URL="${RATEL_METADATA_URL:-http://169.254.169.254}"
RATEL_DMI_DIR="${RATEL_DMI_DIR:-/sys/class/dmi/id}"
README_SERVER_URL="https://github.com/ratel-ai/ratel#on-a-server"
MIN_COMPOSE=2.24
MIN_RAM_MB=4096
MIN_DISK_MB=5120
# The two secrets README.md "On a server" asks for, and the external scheduler's bearer.
ENV_SECRETS="POSTGRES_PASSWORD TRACE_SIGNALS_HASH_SALT CRON_SECRET"
SUDO=""
# The public access mode: docker-compose.caddy.yml runs this image in front of web.
CADDY_IMAGE=caddy:2.11-alpine
CADDY_COMPOSE_FILE=docker-compose.yml:docker-compose.caddy.yml
AUTH_USER=ratel
# README.md "On a server": the SDKs and MCP clients use project API keys on these routes, and a
# monitor reads /api/health. Each prefix also opens its subpaths, but never /v1foo.
OPEN_ROUTES="/v1 /v2 /api/v1 /api/v2 /api/mcp"
HEALTH_ROUTE=/api/health
NEW_PASSWORD=""

main() {
  parse_args "$@"
  say "Ratel installer"

  os=$(uname -s)
  cloud=$(detect_cloud)
  step "Environment"
  info "Host:     $(describe_os "$os") ($(uname -m))"
  info "Platform: $(describe_cloud "$cloud")"
  info "Ref:      $REF"
  info "Dir:      $INSTALL_DIR"

  step "Prerequisites"
  need curl
  ensure_git "$os"
  ensure_docker "$os"
  check_compose
  check_resources

  step "Source"
  fetch_source

  step "Configuration"
  write_env "$INSTALL_DIR"

  step "Access"
  configure_access "$INSTALL_DIR" "$cloud"

  step "Start"
  cd "$INSTALL_DIR"
  info "Building and starting. The first build takes about 5 minutes."
  # .env names the compose files (COMPOSE_FILE). --remove-orphans stops Caddy after a switch to
  # private.
  dc compose up -d --build --wait --remove-orphans
  port=$(env_value RATEL_PORT 3000)
  wait_healthy "http://127.0.0.1:$port/api/health"

  if [ "$WITH_DEMO" = 1 ]; then
    step "Demo data"
    dc compose --profile demo run --rm demo
  fi

  print_summary "$cloud" "$port"
}

# --- Arguments ---------------------------------------------------------------------------------

parse_args() {
  REF="${RATEL_REF:-main}"
  INSTALL_DIR="${RATEL_DIR:-}"
  ASSUME_YES="${RATEL_YES:-0}"
  WITH_DEMO="${RATEL_DEMO:-0}"
  ACCESS="${RATEL_ACCESS:-}"
  DOMAIN="${RATEL_DOMAIN:-}"
  TLS="${RATEL_TLS:-}"
  AUTH_HASH="${RATEL_AUTH_HASH:-}"
  while [ $# -gt 0 ]; do
    case "$1" in
      --ref) [ $# -ge 2 ] || usage_error "--ref needs a value"; REF="$2"; shift ;;
      --ref=*) REF="${1#*=}" ;;
      --dir) [ $# -ge 2 ] || usage_error "--dir needs a value"; INSTALL_DIR="$2"; shift ;;
      --dir=*) INSTALL_DIR="${1#*=}" ;;
      -y | --yes) ASSUME_YES=1 ;;
      --demo) WITH_DEMO=1 ;;
      --access) [ $# -ge 2 ] || usage_error "--access needs a value"; ACCESS="$2"; shift ;;
      --access=*) ACCESS="${1#*=}" ;;
      --domain) [ $# -ge 2 ] || usage_error "--domain needs a value"; DOMAIN="$2"; shift ;;
      --domain=*) DOMAIN="${1#*=}" ;;
      --tls) [ $# -ge 2 ] || usage_error "--tls needs a value"; TLS="$2"; shift ;;
      --tls=*) TLS="${1#*=}" ;;
      --auth-hash) [ $# -ge 2 ] || usage_error "--auth-hash needs a value"; AUTH_HASH="$2"; shift ;;
      --auth-hash=*) AUTH_HASH="${1#*=}" ;;
      -h | --help) usage; exit 0 ;;
      *) usage_error "unknown option: $1" ;;
    esac
    shift
  done
  [ -n "$REF" ] || usage_error "--ref is empty"
  case "$REF" in *..*) usage_error "--ref cannot contain .." ;; esac
  case "$ACCESS" in "" | private | public) ;; *) usage_error "--access is private or public" ;; esac
  case "$TLS" in "" | acme | internal) ;; *) usage_error "--tls is acme or internal" ;; esac
  # The values go into the Caddyfile, so only the characters a name or a bcrypt hash has.
  case "$DOMAIN" in *[!A-Za-z0-9.-]*) usage_error "--domain is not a host name: $DOMAIN" ;; esac
  case "$AUTH_HASH" in
    "") ;;
    *[!A-Za-z0-9./\$]* | [!$]*) usage_error "--auth-hash is not a bcrypt hash" ;;
  esac
  [ -n "$INSTALL_DIR" ] || INSTALL_DIR=$(default_dir)
}

default_dir() {
  if [ "$(id -u)" = 0 ]; then echo /opt/ratel; else echo "$HOME/ratel"; fi
}

usage() {
  cat <<'EOF'
Usage: install.sh [--ref <branch|tag|sha>] [--dir <path>] [--yes] [--demo]
                  [--access private|public] [--domain <name>] [--tls acme|internal]
                  [--auth-hash <bcrypt>]

  --ref        what to check out (default: main)
  --dir        where to put it (default: ~/ratel, or /opt/ratel as root)
  --yes        answer yes to every question
  --demo       load the demo data after the start
  --access     private: ports on 127.0.0.1 only (default on the first run)
               public: Caddy on 80 and 443 with TLS and a login (basic auth)
  --domain     public: the site name (default: <public-ip>.sslip.io)
  --tls        public: acme for Let's Encrypt (default), internal for Caddy's own CA
  --auth-hash  public: the bcrypt hash of the login password (default: a new password)
A rerun keeps the access settings unless you pass new ones.
EOF
}

usage_error() {
  printf 'install.sh: %s\n' "$1" >&2
  usage >&2
  exit 2
}

# --- Environment -------------------------------------------------------------------------------

# Prints aws, gcp, azure, digitalocean, hetzner, oracle or local. DMI answers without a network
# call; the metadata services are the fallback, each with a 1 second limit.
detect_cloud() {
  dmi_cloud && return 0
  if ! curl -s -o /dev/null --connect-timeout 1 --max-time 1 "$RATEL_METADATA_URL/" 2>/dev/null; then
    echo local
    return 0
  fi
  # Header-specific services first: a generic EC2-style service would answer the AWS probe.
  if probe -H "Metadata-Flavor: Google" "$RATEL_METADATA_URL/computeMetadata/v1/instance/id"; then
    echo gcp
  elif probe -H "Metadata: true" "$RATEL_METADATA_URL/metadata/instance/compute/vmId?api-version=2021-02-01&format=text"; then
    echo azure
  elif probe -H "Authorization: Bearer Oracle" "$RATEL_METADATA_URL/opc/v2/instance/id"; then
    echo oracle
  elif probe "$RATEL_METADATA_URL/hetzner/v1/metadata/instance-id"; then
    echo hetzner
  elif probe "$RATEL_METADATA_URL/metadata/v1/id"; then
    echo digitalocean
  elif aws_get /latest/meta-data/instance-id >/dev/null; then
    echo aws
  else
    echo local
  fi
}

# Prints the VM's public IPv4 from its metadata service, or nothing.
public_ip() {
  case "$1" in
    aws) aws_get /latest/meta-data/public-ipv4 ;;
    gcp) fetch -H "Metadata-Flavor: Google" "$RATEL_METADATA_URL/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip" ;;
    azure) fetch -H "Metadata: true" "$RATEL_METADATA_URL/metadata/instance/network/interface/0/ipv4/ipAddress/0/publicIpAddress?api-version=2021-02-01&format=text" ;;
    digitalocean) fetch "$RATEL_METADATA_URL/metadata/v1/interfaces/public/0/ipv4/address" ;;
    hetzner) fetch "$RATEL_METADATA_URL/hetzner/v1/metadata/public-ipv4" ;;
  esac 2>/dev/null || true
}

dmi_cloud() {
  vendor="$(dmi sys_vendor) $(dmi product_name) $(dmi bios_vendor) $(dmi product_version)"
  tag=$(dmi chassis_asset_tag)
  case "$vendor" in
    *Amazon* | *amazon*) echo aws ;;
    *Google*) echo gcp ;;
    *DigitalOcean*) echo digitalocean ;;
    *Hetzner*) echo hetzner ;;
    *Microsoft*) [ "$tag" = 7783-7084-3265-9085-8269-3286-77 ] && echo azure ;;
    *) [ "$tag" = OracleCloud.com ] && echo oracle ;;
  esac
}

dmi() {
  cat "$RATEL_DMI_DIR/$1" 2>/dev/null || true
}

probe() {
  fetch "$@" >/dev/null 2>&1
}

fetch() {
  curl -fsS --connect-timeout 1 --max-time 2 "$@"
}

# IMDSv2: a session token first, then the path with it.
aws_get() {
  token=$(fetch -X PUT -H "X-aws-ec2-metadata-token-ttl-seconds: 60" "$RATEL_METADATA_URL/latest/api/token" 2>/dev/null) || return 1
  fetch -H "X-aws-ec2-metadata-token: $token" "$RATEL_METADATA_URL$1" 2>/dev/null
}

describe_os() {
  case "$1" in
    Darwin) echo "macOS $(sw_vers -productVersion 2>/dev/null)" ;;
    Linux)
      if [ -r /etc/os-release ]; then
        # shellcheck disable=SC1091
        (. /etc/os-release && echo "${PRETTY_NAME:-Linux}")
      else
        echo Linux
      fi
      ;;
    *) echo "$1" ;;
  esac
}

describe_cloud() {
  case "$1" in
    aws) echo "AWS EC2" ;;
    gcp) echo "Google Cloud" ;;
    azure) echo "Microsoft Azure" ;;
    digitalocean) echo "DigitalOcean" ;;
    hetzner) echo "Hetzner Cloud" ;;
    oracle) echo "Oracle Cloud" ;;
    *) echo "local machine" ;;
  esac
}

# --- Prerequisites -----------------------------------------------------------------------------

need() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required. Install it and run the installer again."
  ok "$1"
}

# Minimal server images can lack git. On Linux, offers the distribution's package manager.
ensure_git() {
  if ! command -v git >/dev/null 2>&1 && [ "$1" = Linux ]; then
    manager=$(package_manager)
    [ -n "$manager" ] && confirm "git is not installed. Install it now with $manager?" &&
      case "$manager" in
        apt-get) as_root apt-get update -qq && as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git ;;
        apk) as_root apk add --no-cache git ;;
        *) as_root "$manager" install -y git ;;
      esac
  fi
  need git
}

package_manager() {
  for manager in apt-get dnf yum zypper apk; do
    command -v "$manager" >/dev/null 2>&1 && { echo "$manager"; return 0; }
  done
  return 0
}

# Sets SUDO to "sudo " when only root reaches the Docker daemon. dc runs docker with it.
ensure_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    if [ "$1" != Linux ]; then
      warn "Docker is not installed."
      info "Install Docker Desktop (https://docs.docker.com/get-docker/) or OrbStack (https://orbstack.dev),"
      info "start it, and run the installer again."
      exit 1
    fi
    confirm "Docker is not installed. Install it now with Docker's script from get.docker.com?" ||
      fail "Docker is required. See https://docs.docker.com/engine/install/"
    curl -fsSL https://get.docker.com | as_root sh
  fi
  if docker info >/dev/null 2>&1; then
    SUDO=""
  elif [ "$(id -u)" != 0 ] && command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
    SUDO="sudo "
    info "Your user cannot reach the Docker daemon, so the installer uses sudo."
  else
    fail "Docker is installed but its daemon does not answer. Start Docker and run the installer again."
  fi
  ok "Docker $(dc version --format '{{.Server.Version}}' 2>/dev/null)"
}

check_compose() {
  version=$(dc compose version --short 2>/dev/null) ||
    fail "Docker Compose v2 is required. See https://docs.docker.com/compose/install/"
  version_ge "$version" "$MIN_COMPOSE" ||
    fail "Docker Compose $MIN_COMPOSE or later is required (found $version)."
  ok "Docker Compose $version"
}

# True when version $1 >= $2. Compares the numeric major, minor and patch; ignores a v prefix
# and a suffix such as -desktop.1.
version_ge() {
  set -- "$(normalize_version "$1").0.0" "$(normalize_version "$2").0.0"
  for i in 1 2 3; do
    a=$(echo "$1" | cut -d. -f"$i")
    b=$(echo "$2" | cut -d. -f"$i")
    [ "${a:-0}" -gt "${b:-0}" ] && return 0
    [ "${a:-0}" -lt "${b:-0}" ] && return 1
  done
  return 0
}

normalize_version() {
  echo "$1" | sed -e 's/^v//' -e 's/[^0-9.].*$//'
}

# Docker's own view of memory: on macOS that is the VM, not the Mac.
check_resources() {
  mem=$(dc info --format '{{.MemTotal}}' 2>/dev/null || true)
  mem_mb=$((${mem:-0} / 1024 / 1024))
  if [ "$mem_mb" -gt 0 ] && [ "$mem_mb" -lt "$MIN_RAM_MB" ]; then
    warn "Docker has ${mem_mb} MB of RAM. Ratel needs 4 GB (8 GB is comfortable)."
  else
    ok "RAM ${mem_mb} MB"
  fi

  disk_dir=$(dirname "$INSTALL_DIR")
  while [ ! -d "$disk_dir" ]; do disk_dir=$(dirname "$disk_dir"); done
  root_dir=$(dc info --format '{{.DockerRootDir}}' 2>/dev/null || true)
  [ -n "$root_dir" ] && [ -d "$root_dir" ] && disk_dir="$root_dir"
  free_mb=$(df -Pk "$disk_dir" 2>/dev/null | awk 'NR == 2 { print int($4 / 1024) }')
  if [ "${free_mb:-0}" -lt "$MIN_DISK_MB" ]; then
    warn "${free_mb:-0} MB free on $disk_dir. Ratel needs about 5 GB."
  else
    ok "Disk ${free_mb} MB free"
  fi
}

# --- Source ------------------------------------------------------------------------------------

# Clones on the first run. On a later run fetches and checks out the ref, fast-forward only, and
# stops on local changes rather than discarding them.
fetch_source() {
  if [ -d "$INSTALL_DIR/.git" ]; then
    cd "$INSTALL_DIR"
    if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
      fail "$INSTALL_DIR has local changes. Commit or stash them, then run the installer again."
    fi
    info "Existing checkout found. Upgrading to $REF."
    git fetch --quiet --tags origin
  elif [ -e "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]; then
    fail "$INSTALL_DIR exists and is not a Ratel checkout. Choose another path with --dir."
  else
    mkdir -p "$(dirname "$INSTALL_DIR")"
    git clone --quiet --filter=blob:none "$RATEL_REPO" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
  fi

  if git show-ref --verify --quiet "refs/remotes/origin/$REF"; then
    if git show-ref --verify --quiet "refs/heads/$REF"; then
      git checkout --quiet "$REF"
      git merge --quiet --ff-only "origin/$REF" ||
        fail "$REF has local commits that are not on origin. Resolve them, then run the installer again."
    else
      git checkout --quiet -b "$REF" "origin/$REF"
    fi
  else
    git fetch --quiet origin "$REF" 2>/dev/null || true
    git checkout --quiet --detach "$REF" 2>/dev/null ||
      fail "$REF is not a branch, tag or commit of $RATEL_REPO."
  fi
  ok "$(git log -1 --format='%h %s' | cut -c1-72)"
}

# --- Configuration -----------------------------------------------------------------------------

# Creates .env from .env.example with a random value for each secret. An existing .env is kept
# as it is. The values are never printed.
write_env() {
  if [ -f "$1/.env" ]; then
    ok ".env exists. Keeping it."
    return 0
  fi
  tmp="$1/.env.tmp.$$"
  # A subshell, so the owner-only umask covers every file written here and nothing after.
  (
    umask 077
    cat "$1/.env.example" >"$tmp"
    for name in $ENV_SECRETS; do
      secret=$(random_hex)
      if grep -q "^$name=" "$tmp"; then
        sed "s/^$name=.*/$name=$secret/" "$tmp" >"$tmp.next" && mv "$tmp.next" "$tmp"
      else
        printf '\n%s=%s\n' "$name" "$secret" >>"$tmp"
      fi
    done
  )
  mv "$tmp" "$1/.env"
  ok "Created .env with new random secrets ($(echo "$ENV_SECRETS" | sed 's/ /, /g'))."
  info "Keep a copy of .env: a lost TRACE_SIGNALS_HASH_SALT splits old hashes from new."
}

random_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -tx1 -N32 /dev/urandom | tr -d ' \n'
    echo
  fi
}

env_value() {
  found=$(sed -n "s/^$1=//p" .env 2>/dev/null | tail -n 1)
  echo "${found:-$2}"
}

# --- Access ------------------------------------------------------------------------------------

# Private keeps the ports on 127.0.0.1. Public writes ./Caddyfile and adds the Caddy overlay to
# COMPOSE_FILE in .env, so every `docker compose` command in the directory includes it. With no
# flags, a rerun keeps the mode: public while a Caddyfile exists.
configure_access() {
  caddyfile="$1/Caddyfile"
  if [ -z "$ACCESS" ]; then
    if [ -f "$caddyfile" ]; then ACCESS=public; else ACCESS=private; fi
  fi
  if [ "$ACCESS" = private ]; then
    rm -f "$caddyfile"
    set_env_line "$1/.env" COMPOSE_FILE ""
    ok "Private: the console listens on 127.0.0.1 only."
    return 0
  fi

  [ -n "$DOMAIN" ] || DOMAIN=$(caddy_setting domain "$caddyfile")
  if [ -z "$DOMAIN" ]; then
    ip=$(public_ip "$2")
    [ -n "$ip" ] || fail "--access public needs --domain: this machine has no public IP to use."
    DOMAIN="$ip.sslip.io"
  fi
  [ -n "$TLS" ] || TLS=$(caddy_setting tls "$caddyfile")
  [ -n "$TLS" ] || TLS=acme
  [ -n "$AUTH_HASH" ] || AUTH_HASH=$(caddy_setting hash "$caddyfile")
  if [ -z "$AUTH_HASH" ]; then
    NEW_PASSWORD=$(random_hex | cut -c1-24)
    AUTH_HASH=$(dc run --rm "$CADDY_IMAGE" caddy hash-password --plaintext "$NEW_PASSWORD" | tail -n 1)
  fi

  (umask 077 && write_caddyfile "$DOMAIN" "$AUTH_HASH" "$TLS" >"$caddyfile.tmp") && mv "$caddyfile.tmp" "$caddyfile"
  set_env_line "$1/.env" COMPOSE_FILE "$CADDY_COMPOSE_FILE"
  # The console builds its snippets from BASE_URL. Only the example's default is replaced.
  if [ "$(sed -n 's/^BASE_URL=//p' "$1/.env" | tail -n 1)" = "http://localhost:3000" ]; then
    set_env_line "$1/.env" BASE_URL "https://$DOMAIN"
  fi
  ok "Public: Caddy serves https://$DOMAIN ($TLS TLS), with a login for user $AUTH_USER."
}

# Prints the Caddyfile for the public mode. The API-key routes and /api/health pass without the
# login. Caddy matches on the cleaned path, so /api/v1/../x does not pass.
write_caddyfile() {
  open=$HEALTH_ROUTE
  for route in $OPEN_ROUTES; do open="$open $route $route/*"; done
  printf '# Written by install.sh --access public. Rerun the installer to change it.\n'
  printf '%s {\n' "$1"
  [ "$3" = internal ] && printf '\ttls internal\n'
  printf '\t@open path %s\n' "$open"
  printf '\thandle @open {\n\t\treverse_proxy web:3000\n\t}\n'
  printf '\thandle {\n\t\tbasic_auth {\n\t\t\t%s %s\n\t\t}\n' "$AUTH_USER" "$2"
  printf '\t\treverse_proxy web:3000\n\t}\n}\n'
}

# Reads one setting (domain, hash or tls) back from a Caddyfile that write_caddyfile wrote.
caddy_setting() {
  [ -f "$2" ] || return 0
  case "$1" in
    domain) sed -n 's/^\([^#[:space:]][^[:space:]]*\) {$/\1/p' "$2" | head -n 1 ;;
    hash) awk '/basic_auth \{/ { getline; print $2; exit }' "$2" ;;
    tls) if grep -q '^[[:space:]]*tls internal$' "$2"; then echo internal; else echo acme; fi ;;
  esac
}

# Sets NAME=value in an env file, or removes it when the value is empty. Other lines stay.
set_env_line() {
  [ -f "$1" ] || return 0
  # .env holds secrets: the copy is owner-only too, and `cat >` keeps the file's own mode.
  (
    umask 077
    grep -v "^$2=" "$1" >"$1.next" || true
    [ -z "$3" ] || printf '%s=%s\n' "$2" "$3" >>"$1.next"
  )
  cat "$1.next" >"$1"
  rm -f "$1.next"
}

# --- Start -------------------------------------------------------------------------------------

wait_healthy() {
  i=0
  until curl -fsS --max-time 2 "$1" >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -lt 60 ] || fail "$1 did not answer in 2 minutes. Read: ${SUDO}docker compose logs db web worker"
    sleep 2
  done
  ok "Healthy: $1"
}

print_summary() {
  cloud=$1
  port=$2
  url=$(env_value BASE_URL "http://localhost:$port")
  step "Ratel is running"
  if [ "$ACCESS" = public ]; then
    print_public_access
  else
    print_private_access "$cloud" "$port" "$url"
  fi
  info ""
  info "Upgrade:  rerun the installer with the same --dir (and --ref)"
  info "Backup:   cd $INSTALL_DIR && ${SUDO}docker compose exec -T db pg_dump -U ratel ratel > ratel.sql"
  info "Logs:     cd $INSTALL_DIR && ${SUDO}docker compose logs -f web worker"
  info "Stop:     cd $INSTALL_DIR && ${SUDO}docker compose down"
}

print_public_access() {
  info "Open:     https://$DOMAIN"
  info "User:     $AUTH_USER"
  if [ -n "$NEW_PASSWORD" ]; then
    info "Password: $NEW_PASSWORD"
    info "          Shown once. Save it now: only its hash is kept, in $INSTALL_DIR/Caddyfile."
  else
    info "Password: the one you set (its hash is in $INSTALL_DIR/Caddyfile)"
  fi
  [ "$TLS" = internal ] && info "TLS:      Caddy's own CA, so the browser warns until you trust it."
  info ""
  info "The SDK and MCP routes ($OPEN_ROUTES) and $HEALTH_ROUTE pass without the login:"
  info "they use project API keys."
}

print_private_access() {
  cloud=$1
  port=$2
  info "Open:     $3"
  if [ "$cloud" != local ]; then
    ip=$(public_ip "$cloud")
    info ""
    info "The console has no login, so it listens on 127.0.0.1 only. From your laptop, tunnel to it:"
    info "  ssh -L $port:127.0.0.1:$port ${SUDO_USER:-$(id -un)}@${ip:-<public-ip>}"
    info "then open http://localhost:$port"
  fi
  info ""
  info "To expose it publicly with TLS and a login, rerun with --access public, or use your own"
  info "proxy: $README_SERVER_URL"
}

# --- Helpers -----------------------------------------------------------------------------------

# Asks on the terminal, since stdin is the script under `curl | sh`. No terminal and no --yes
# means no.
confirm() {
  [ "$ASSUME_YES" = 1 ] && return 0
  (: </dev/tty) 2>/dev/null || { warn "$1 No terminal to ask on. Pass --yes to accept."; return 1; }
  printf '%s [y/N] ' "$1" >/dev/tty
  read -r answer </dev/tty || return 1
  case "$answer" in y | Y | yes | YES) return 0 ;; *) return 1 ;; esac
}

dc() {
  if [ -n "$SUDO" ]; then sudo docker "$@"; else docker "$@"; fi
}

as_root() {
  if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi
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
[ "${RATEL_INSTALL_SOURCE_ONLY:-}" = 1 ] || main "$@"
