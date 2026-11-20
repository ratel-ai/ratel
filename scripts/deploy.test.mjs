import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("../deploy.sh", import.meta.url));
const MODULES = fileURLToPath(new URL("../deploy/terraform", import.meta.url));
const CLOUDS = ["aws", "gcp", "azure", "digitalocean", "hetzner"];
// Only the system tools: the real cloud CLIs, tofu and terraform stay out of every test.
const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/**
 * Sources deploy.sh without running it, then runs `body` in the same POSIX shell. `bin` maps a
 * command name to a fake executable's shell body, so a test chooses which CLIs exist and what
 * they answer.
 */
const sh = async (body, { args = [], env = {}, bin = {} } = {}) => {
  const home = mkdtempSync(join(tmpdir(), "ratel-deploy-home-"));
  const dir = mkdtempSync(join(tmpdir(), "ratel-deploy-bin-"));
  for (const [name, script] of Object.entries(bin)) {
    writeFileSync(join(dir, name), `#!/bin/sh\n${script}\n`);
    chmodSync(join(dir, name), 0o755);
  }
  try {
    const { stdout, stderr } = await run("sh", ["-c", `. "${SCRIPT}"\n${body}`, "sh", ...args], {
      env: { PATH: `${dir}:${SYSTEM_PATH}`, HOME: home, RATEL_DEPLOY_SOURCE_ONLY: "1", ...env },
    });
    return { code: 0, stdout, stderr, home };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr, home };
  }
};

const FIELDS = ["COMMAND", "NAME", "CLOUD", "REGION", "SIZE", "REF", "ACCESS", "DOMAIN", "ALLOW_CIDRS", "IAC", "ASSUME_YES"];
const parsed = async (args) => {
  const result = await sh(`parse_args "$@"\n${FIELDS.map((f) => `printf '%s\\n' "$${f}"`).join("\n")}`, { args });
  if (result.code !== 0) return result;
  return { ...result, values: Object.fromEntries(FIELDS.map((f, i) => [f, result.stdout.split("\n")[i]])) };
};

test("parse_args defaults to up, the name ratel and interactive, and leaves the rest for later", async () => {
  const { values } = await parsed([]);
  assert.deepEqual(values, {
    COMMAND: "up",
    NAME: "ratel",
    CLOUD: "",
    REGION: "",
    SIZE: "",
    REF: "",
    ACCESS: "",
    DOMAIN: "",
    ALLOW_CIDRS: "",
    IAC: "",
    ASSUME_YES: "0",
  });
});

test("parse_args reads every flag in both spellings, and --allow-cidr repeats", async () => {
  const { values } = await parsed([
    "up",
    "--cloud",
    "gcp",
    "--region=europe-west1",
    "--size",
    "e2-standard-4",
    "--name",
    "ratel-eu",
    "--ref=v1.2.3",
    "--access",
    "public",
    "--domain",
    "ratel.example.com",
    "--allow-cidr",
    "10.0.0.0/8",
    "--allow-cidr=192.168.1.0/24",
    "--iac",
    "tofu",
    "--yes",
  ]);
  assert.deepEqual(values, {
    COMMAND: "up",
    NAME: "ratel-eu",
    CLOUD: "gcp",
    REGION: "europe-west1",
    SIZE: "e2-standard-4",
    REF: "v1.2.3",
    ACCESS: "public",
    DOMAIN: "ratel.example.com",
    ALLOW_CIDRS: "10.0.0.0/8 192.168.1.0/24",
    IAC: "tofu",
    ASSUME_YES: "1",
  });
});

test("parse_args takes status and destroy as the command, flags before or after", async () => {
  assert.equal((await parsed(["status"])).values.COMMAND, "status");
  const destroy = await parsed(["--name", "x1", "destroy", "-y"]);
  assert.equal(destroy.values.COMMAND, "destroy");
  assert.equal(destroy.values.NAME, "x1");
  assert.equal(destroy.values.ASSUME_YES, "1");
});

test("parse_args rejects bad values with exit 2", async () => {
  for (const args of [
    ["--cloud", "oracle"],
    ["--access", "open"],
    ["--iac", "pulumi"],
    ["--name", "Bad_Name"],
    ["--name", "ends-"],
    ["--allow-cidr", "10.0.0.0"],
    ["--allow-cidr", "0.0.0.0/0;x"],
    ["--domain", "a b"],
    ["--region", "us east"],
    ["--ref", "a;b"],
    ["--nope"],
    ["--cloud"],
    ["up", "status"],
    ["deploy"],
  ]) {
    assert.equal((await parsed(args)).code, 2, args.join(" "));
  }
});

test("apply_defaults fills the public mode, main and each cloud's region and size", async () => {
  const expected = {
    aws: "us-east-1|t3.large",
    gcp: "us-central1|e2-standard-2",
    azure: "eastus|Standard_B2ms",
    digitalocean: "nyc3|s-4vcpu-8gb",
    hetzner: "nbg1|cx33",
  };
  for (const cloud of CLOUDS) {
    const { stdout } = await sh(`CLOUD=${cloud}\napply_defaults\nprintf '%s|%s|%s|%s\\n' "$ACCESS" "$REF" "$REGION" "$SIZE"`);
    assert.equal(stdout.trim(), `public|main|${expected[cloud]}`, cloud);
  }
  const { stdout } = await sh('CLOUD=aws REGION=eu-west-1 SIZE=m7i.large ACCESS=private REF=v1\napply_defaults\necho "$ACCESS|$REF|$REGION|$SIZE"');
  assert.equal(stdout.trim(), "private|v1|eu-west-1|m7i.large");
});

test("apply_defaults takes the region the cloud CLI is set to", async () => {
  const aws = await sh('CLOUD=aws\napply_defaults\necho "$REGION"', { bin: { aws: 'echo "eu-south-1"' } });
  assert.equal(aws.stdout.trim(), "eu-south-1");
  const env = await sh('CLOUD=aws\napply_defaults\necho "$REGION"', { env: { AWS_REGION: "ap-south-1" } });
  assert.equal(env.stdout.trim(), "ap-south-1");
  const gcp = await sh('CLOUD=gcp\napply_defaults\necho "$REGION"', { bin: { gcloud: 'echo "europe-west4"' } });
  assert.equal(gcp.stdout.trim(), "europe-west4");
});

// Fake CLIs that answer like a logged-in session.
const LOGGED_IN = {
  aws: `[ "$1 $2" = "sts get-caller-identity" ] && echo 123456789012`,
  gcloud: `case "$*" in *account*) echo me@example.com ;; *project*) echo my-project ;; *) exit 1 ;; esac`,
  az: `[ "$1 $2" = "account show" ] && echo "My subscription"`,
  doctl: `[ "$1 $2" = "account get" ] && echo me@example.com`,
  hcloud: `[ "$1 $2" = "context active" ] && echo work`,
};
const LOGGED_OUT = {
  aws: "echo 'Unable to locate credentials' >&2; exit 255",
  gcloud: "echo '(unset)' >&2; exit 0",
  az: "echo 'Please run az login' >&2; exit 1",
  doctl: "echo 'Unable to initialize' >&2; exit 1",
  hcloud: "exit 0",
};

const detected = async (bin, env) => (await sh("detect_clouds", { bin, env })).stdout.trim();

test("detect_clouds finds no cloud with no CLI and no token", async () => {
  assert.equal(await detected({}), "");
  assert.equal(await detected(LOGGED_OUT), "");
});

test("detect_clouds finds each logged-in CLI, with the account it uses", async () => {
  assert.equal(await detected({ aws: LOGGED_IN.aws }), "aws account 123456789012");
  assert.equal(await detected({ gcloud: LOGGED_IN.gcloud }), "gcp me@example.com, project my-project");
  assert.equal(await detected({ az: LOGGED_IN.az }), "azure subscription My subscription");
  assert.equal(await detected({ doctl: LOGGED_IN.doctl }), "digitalocean doctl, me@example.com");
  assert.equal(await detected({ hcloud: LOGGED_IN.hcloud }), "hetzner hcloud context work");
});

test("detect_clouds counts gcloud only with both an account and a project", async () => {
  const noProject = `case "$*" in *account*) echo me@example.com ;; *) echo '(unset)' >&2 ;; esac`;
  assert.equal(await detected({ gcloud: noProject }), "");
});

test("detect_clouds takes the DigitalOcean and Hetzner tokens from the environment", async () => {
  const env = { DIGITALOCEAN_TOKEN: "do-token", HCLOUD_TOKEN: "h-token" };
  const lines = (await detected({}, env)).split("\n");
  assert.deepEqual(lines, ["digitalocean DIGITALOCEAN_TOKEN", "hetzner HCLOUD_TOKEN"]);
  assert.ok(!lines.join().includes("do-token"), "the token itself is never printed");
});

test("detect_clouds lists several clouds in a fixed order", async () => {
  const lines = (await detected(LOGGED_IN)).split("\n").map((line) => line.split(" ")[0]);
  assert.deepEqual(lines, CLOUDS);
});

const choose = (bin, { env = {}, before = "" } = {}) =>
  sh(`${before}\nchoose_cloud\necho "chosen=$CLOUD"`, { bin, env: { RATEL_NO_TTY: "1", ...env } });

test("choose_cloud uses the one cloud it finds", async () => {
  const { stdout, code } = await choose({ gcloud: LOGGED_IN.gcloud, aws: LOGGED_OUT.aws });
  assert.equal(code, 0);
  assert.match(stdout, /chosen=gcp$/m);
});

test("choose_cloud with several clouds and --yes stops and asks for --cloud", async () => {
  const { code, stderr } = await choose(LOGGED_IN, { before: "ASSUME_YES=1" });
  assert.equal(code, 1);
  assert.match(stderr, /several clouds.*--cloud/s);
});

test("choose_cloud with several clouds and no terminal stops too", async () => {
  const { code, stderr } = await choose(LOGGED_IN);
  assert.equal(code, 1);
  assert.match(stderr, /--cloud/);
});

test("choose_cloud with several clouds asks on the terminal", async () => {
  const { stdout, code } = await choose(LOGGED_IN, { before: "has_tty() { return 0; }\nask() { echo 3; }" });
  assert.equal(code, 0);
  assert.match(stdout, /chosen=azure$/m);
});

test("choose_cloud takes --cloud when that cloud is logged in", async () => {
  const { stdout } = await choose(LOGGED_IN, { before: "CLOUD=hetzner ASSUME_YES=1" });
  assert.match(stdout, /chosen=hetzner$/m);
});

test("choose_cloud with --cloud for a cloud that is not logged in prints its login", async () => {
  const { code, stderr, stdout } = await choose({ gcloud: LOGGED_IN.gcloud }, { before: "CLOUD=azure" });
  assert.equal(code, 1);
  assert.match(`${stdout}${stderr}`, /az login/);
});

test("choose_cloud with no cloud prints how to log in to each one", async () => {
  const { code, stdout, stderr } = await choose({});
  assert.equal(code, 1);
  const text = `${stdout}${stderr}`;
  for (const hint of ["aws", "gcloud auth login", "az login", "DIGITALOCEAN_TOKEN", "HCLOUD_TOKEN"]) {
    assert.ok(text.includes(hint), hint);
  }
});

const engine = (bin, iac = "") =>
  sh(`IAC=${iac}\nchoose_engine\necho "engine=$ENGINE"`, { bin });
const VERSION = 'echo "v1.0.0"';

test("choose_engine prefers tofu, then terraform", async () => {
  assert.match((await engine({ tofu: VERSION, terraform: VERSION })).stdout, /engine=tofu$/m);
  assert.match((await engine({ terraform: VERSION })).stdout, /engine=terraform$/m);
});

test("choose_engine follows --iac", async () => {
  assert.match((await engine({ tofu: VERSION, terraform: VERSION }, "terraform")).stdout, /engine=terraform$/m);
});

test("choose_engine prints the install command when the engine is missing", async () => {
  const none = await engine({});
  assert.equal(none.code, 1);
  assert.match(`${none.stdout}${none.stderr}`, /opentofu/i);
  const missing = await engine({ tofu: VERSION }, "terraform");
  assert.equal(missing.code, 1);
  assert.match(`${missing.stdout}${missing.stderr}`, /terraform/);
});

test("init_state makes an owner-only directory with a dedicated ed25519 key", async () => {
  const { home, code } = await sh('STATE="$HOME/.ratel/deploy/ratel"\ninit_state');
  assert.equal(code, 0);
  const state = join(home, ".ratel/deploy/ratel");
  assert.equal(statSync(state).mode & 0o777, 0o700);
  assert.equal(statSync(join(state, "id_ed25519")).mode & 0o777, 0o600);
  assert.match(readFileSync(join(state, "id_ed25519.pub"), "utf8"), /^ssh-ed25519 \S+ ratel-deploy-ratel\n$/);
});

test("init_state keeps an existing key", async () => {
  const { stdout } = await sh(
    'STATE="$HOME/s"\ninit_state\na=$(cat "$STATE/id_ed25519.pub")\ninit_state\nb=$(cat "$STATE/id_ed25519.pub")\n[ "$a" = "$b" ] && echo same',
  );
  assert.equal(stdout.trim(), "same");
});

test("save_config and config_get keep the deploy's settings, owner-only", async () => {
  const { stdout, home } = await sh(
    'STATE="$HOME/s"\ninit_state\nCLOUD=gcp ENGINE=tofu REGION=r SIZE=s ACCESS=private DOMAIN= ALLOW_CIDRS="10.0.0.0/8 10.1.0.0/16" REF=v1 PROJECT=p MY_IP=203.0.113.9\nsave_config\nCLOUD= ENGINE=\nprintf "%s|%s|%s|%s\\n" "$(config_get CLOUD)" "$(config_get ENGINE)" "$(config_get ALLOW_CIDRS)" "$(config_get DOMAIN)"',
  );
  assert.equal(stdout.trim(), "gcp|tofu|10.0.0.0/8 10.1.0.0/16|");
  assert.equal(statSync(join(home, "s/config")).mode & 0o777, 0o600);
});

test("save_login writes the console password owner-only and never prints it", async () => {
  const { stdout, home } = await sh('STATE="$HOME/s"\ninit_state\nsave_login https://x.example ratel s3cret-pass');
  assert.ok(!stdout.includes("s3cret-pass"));
  const file = join(home, "s/login");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(readFileSync(file, "utf8"), "url=https://x.example\nuser=ratel\npassword=s3cret-pass\n");
});

const tfvars = async (setup) => {
  const { stdout } = await sh(
    `STATE="$HOME/s"\ninit_state\nNAME=ratel CLOUD=gcp REGION=us-central1 SIZE=e2-standard-2 REF=main PROJECT=p DOMAIN= MY_IP=203.0.113.9\n${setup}\nwrite_tfvars "$HOME/t.tfvars"\ncat "$HOME/t.tfvars"`,
  );
  return Object.fromEntries(
    stdout
      .split("\n")
      .filter((line) => line.includes(" = "))
      .map((line) => [line.split(" = ")[0], line.slice(line.indexOf(" = ") + 3)]),
  );
};

test("write_tfvars opens 80 and 443 to all and 22 to the caller's IP only, in public mode", async () => {
  const vars = await tfvars("ACCESS=public ALLOW_CIDRS=");
  assert.equal(vars.web_cidrs, '["0.0.0.0/0"]');
  assert.equal(vars.ssh_cidrs, '["203.0.113.9/32"]');
  assert.equal(vars.access, '"public"');
  assert.equal(vars.tls, '"acme"');
  assert.equal(vars.project, '"p"');
  assert.equal(vars.install_url, '"https://raw.githubusercontent.com/ratel-ai/ratel/main/install.sh"');
  assert.match(vars.ssh_public_key, /^"ssh-ed25519 /);
});

test("write_tfvars opens 80 and 443 to --allow-cidr only, with Caddy's own CA, in public mode", async () => {
  const vars = await tfvars('ACCESS=public ALLOW_CIDRS="10.0.0.0/8 192.168.0.0/16"');
  assert.equal(vars.web_cidrs, '["10.0.0.0/8", "192.168.0.0/16"]');
  assert.equal(vars.ssh_cidrs, '["203.0.113.9/32"]');
  assert.equal(vars.tls, '"internal"', "Let's Encrypt cannot reach a closed port 80");
});

test("write_tfvars opens no web port and 22 to the caller and --allow-cidr, in private mode", async () => {
  const vars = await tfvars('ACCESS=private ALLOW_CIDRS="10.0.0.0/8"');
  assert.equal(vars.web_cidrs, "[]");
  assert.equal(vars.ssh_cidrs, '["203.0.113.9/32", "10.0.0.0/8"]');
});

test("write_tfvars writes the project only for gcp", async () => {
  const vars = await tfvars("CLOUD=aws ACCESS=public ALLOW_CIDRS=");
  assert.equal(vars.project, undefined);
});

test("print_costs lists each size of the cloud, one line each, and marks the chosen one", async () => {
  const { stdout } = await sh("print_costs aws t3.large");
  const lines = stdout.split("\n").filter((line) => /vCPU/.test(line));
  assert.ok(lines.length >= 3);
  assert.equal(lines.filter((line) => line.includes("t3.large")).length, 1);
  assert.match(lines.find((line) => line.includes("t3.large")), /^\s*> t3\.large\s+2 vCPU\s+8 GB\s+~US\$\d+/);
  for (const cloud of CLOUDS) {
    const { stdout: text } = await sh(`print_costs ${cloud} none`);
    assert.ok(text.split("\n").filter((line) => /vCPU/.test(line)).length >= 2, cloud);
    assert.match(text, /none: not in this list/);
  }
});

test("caller_ip takes the first service that answers with an IPv4 address", async () => {
  const curl = `case "$*" in *checkip*) echo '<html>' ;; *ipify*) echo 198.51.100.7 ;; esac`;
  const { stdout } = await sh("caller_ip", { bin: { curl } });
  assert.equal(stdout.trim(), "198.51.100.7");
  const none = await sh("caller_ip", { bin: { curl: "exit 7" } });
  assert.equal(none.code, 1);
});

test("plan_summary prints the resource lines and the totals of a plan", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ratel-plan-"));
  const log = join(dir, "plan.log");
  writeFileSync(
    log,
    [
      "Terraform will perform the following actions:",
      "",
      '  # google_compute_address.ratel will be created',
      '  + resource "google_compute_address" "ratel" {',
      '      + name = "ratel"',
      "    }",
      "  # google_compute_instance.ratel will be created",
      "",
      "Plan: 2 to add, 0 to change, 0 to destroy.",
    ].join("\n"),
  );
  const { stdout } = await sh(`plan_summary "${log}"`);
  assert.match(stdout, /\+ google_compute_address\.ratel\n.*\+ google_compute_instance\.ratel\n.*Plan: 2 to add/s);
  assert.doesNotMatch(stdout, /name = /);
});

// The contract between deploy.sh and the modules: the same inputs and outputs in each cloud.
const COMMON_VARIABLES = ["name", "region", "size", "ssh_public_key", "ssh_cidrs", "web_cidrs", "access", "domain", "tls", "ref", "install_url"];
const OUTPUTS = ["public_ip", "ssh_user", "domain", "url", "password"];
const declared = (dir, kind) =>
  readdirSync(dir)
    .filter((file) => file.endsWith(".tf"))
    .flatMap((file) => [...readFileSync(join(dir, file), "utf8").matchAll(new RegExp(`^${kind} "([a-z_]+)"`, "gm"))])
    .map((match) => match[1]);

test("every cloud module takes the common variables and gives the common outputs", () => {
  for (const cloud of CLOUDS) {
    const dir = join(MODULES, cloud);
    assert.ok(existsSync(dir), cloud);
    const variables = declared(dir, "variable");
    for (const name of COMMON_VARIABLES) assert.ok(variables.includes(name), `${cloud}: variable ${name}`);
    assert.equal(variables.includes("project"), cloud === "gcp", `${cloud}: project`);
    const outputs = declared(dir, "output");
    for (const name of OUTPUTS) assert.ok(outputs.includes(name), `${cloud}: output ${name}`);
  }
});

test("every cloud module uses the shared cloud-init and keeps a user_data change off the VM", () => {
  for (const cloud of CLOUDS) {
    const main = readFileSync(join(MODULES, cloud, "main.tf"), "utf8");
    assert.match(main, /source\s+= "\.\.\/cloud-init"/, cloud);
    assert.match(main, /ignore_changes\s+= \[[^\]]*(user_data|custom_data|metadata)/, cloud);
  }
});

test("every module runs on Terraform 1.5.7, the last version GCP Infrastructure Manager runs at no cost", () => {
  for (const mod of [...CLOUDS, "cloud-init"]) {
    const main = readFileSync(join(MODULES, mod, "main.tf"), "utf8");
    assert.match(main, /required_version = ">= 1\.5\.7"/, mod);
  }
});

test("the shared cloud-init checks every value that reaches the install command", () => {
  const main = readFileSync(join(MODULES, "cloud-init", "main.tf"), "utf8");
  for (const name of ["domain", "ref", "install_url"]) {
    const block = main.slice(main.indexOf(`variable "${name}"`), main.indexOf("\n}\n", main.indexOf(`variable "${name}"`)));
    assert.match(block, /validation \{\n\s+condition\s+= can\(regex\(/, name);
  }
});

test("deploy.sh downloads exactly the module files that exist", () => {
  const script = readFileSync(SCRIPT, "utf8");
  const shared = script.match(/^SHARED_FILES="([^"]+)"/m)?.[1].split(" ");
  const own = script.match(/^MODULE_FILES="([^"]+)"/m)?.[1].split(" ");
  assert.deepEqual(shared.sort(), readdirSync(join(MODULES, "cloud-init")).filter((f) => !f.startsWith(".")).sort());
  for (const cloud of CLOUDS) {
    const files = readdirSync(join(MODULES, cloud)).filter((f) => f.endsWith(".tf"));
    assert.deepEqual(own.slice().sort(), files.sort(), cloud);
  }
});

test("stage_modules copies the shared and the cloud module from a local checkout", async () => {
  const { home, code } = await sh(`STATE="$HOME/s" TF_ROOT="$HOME/s/tf" CLOUD=hetzner\ninit_state\nstage_modules "${MODULES}"`);
  assert.equal(code, 0);
  assert.ok(existsSync(join(home, "s/tf/hetzner/main.tf")));
  assert.ok(existsSync(join(home, "s/tf/cloud-init/main.tf")));
  assert.ok(!existsSync(join(home, "s/tf/aws")));
});
