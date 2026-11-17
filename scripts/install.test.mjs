import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("../install.sh", import.meta.url));
const EXAMPLE = fileURLToPath(new URL("../.env.example", import.meta.url));

/** Sources install.sh without running it, then runs `body` in the same POSIX shell. */
const sh = async (body, { args = [], env = {} } = {}) => {
  const home = mkdtempSync(join(tmpdir(), "ratel-install-home-"));
  try {
    const { stdout } = await run("sh", ["-c", `. "${SCRIPT}"\n${body}`, "sh", ...args], {
      env: { PATH: process.env.PATH, HOME: home, RATEL_INSTALL_SOURCE_ONLY: "1", ...env },
    });
    return { code: 0, stdout };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
};

const parsed = (args, env) =>
  sh('parse_args "$@"\nprintf "%s|%s|%s|%s\\n" "$REF" "$INSTALL_DIR" "$ASSUME_YES" "$WITH_DEMO"', {
    args,
    env,
  });

test("parse_args defaults to main, ~/ratel, interactive and no demo", async () => {
  const { stdout } = await parsed([]);
  assert.match(stdout.trim(), /^main\|\/.+\/ratel\|0\|0$/);
  assert.doesNotMatch(stdout, /\/opt\/ratel/);
});

test("parse_args reads every flag, in both spellings", async () => {
  const spaced = await parsed(["--ref", "v1.2.3", "--dir", "/srv/r", "--yes", "--demo"]);
  assert.equal(spaced.stdout.trim(), "v1.2.3|/srv/r|1|1");
  const joined = await parsed(["--ref=abc123", "--dir=/x", "-y"]);
  assert.equal(joined.stdout.trim(), "abc123|/x|1|0");
});

test("parse_args takes the same settings from the environment, flags win", async () => {
  const env = { RATEL_REF: "dev", RATEL_DIR: "/e", RATEL_YES: "1", RATEL_DEMO: "1" };
  assert.equal((await parsed([], env)).stdout.trim(), "dev|/e|1|1");
  assert.equal((await parsed(["--ref", "flag"], env)).stdout.trim(), "flag|/e|1|1");
});

test("parse_args rejects an unknown flag and a flag with no value", async () => {
  assert.equal((await parsed(["--nope"])).code, 2);
  assert.equal((await parsed(["--ref"])).code, 2);
});

test("version_ge compares Compose versions numerically, with or without a v", async () => {
  const cases = [
    ["2.24.0", true],
    ["v2.24.1", true],
    ["2.29.7-desktop.1", true],
    ["5.5.0", true],
    ["2.23.9", false],
    ["2.3.0", false],
    ["1.29.2", false],
  ];
  for (const [version, expected] of cases) {
    const { code } = await sh(`version_ge "${version}" 2.24`);
    assert.equal(code === 0, expected, version);
  }
});

/** A metadata service that answers only the given routes, like a real one does. */
const metadata = async (routes) => {
  const server = createServer((req, res) => {
    const route = routes[`${req.method} ${req.url}`];
    if (!route || !route.ok(req.headers)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200).end(route.body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
};

const any = () => true;
const PROVIDERS = {
  aws: {
    "PUT /latest/api/token": { ok: (h) => h["x-aws-ec2-metadata-token-ttl-seconds"], body: "tok" },
    "GET /latest/meta-data/instance-id": { ok: (h) => h["x-aws-ec2-metadata-token"] === "tok", body: "i-1" },
    "GET /latest/meta-data/public-ipv4": { ok: (h) => h["x-aws-ec2-metadata-token"] === "tok", body: "203.0.113.1" },
  },
  gcp: {
    "GET /computeMetadata/v1/instance/id": { ok: (h) => h["metadata-flavor"] === "Google", body: "1" },
    "GET /computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip": {
      ok: (h) => h["metadata-flavor"] === "Google",
      body: "203.0.113.2",
    },
  },
  azure: {
    "GET /metadata/instance/compute/vmId?api-version=2021-02-01&format=text": {
      ok: (h) => h.metadata === "true",
      body: "vm",
    },
    "GET /metadata/instance/network/interface/0/ipv4/ipAddress/0/publicIpAddress?api-version=2021-02-01&format=text":
      { ok: (h) => h.metadata === "true", body: "203.0.113.3" },
  },
  digitalocean: {
    "GET /metadata/v1/id": { ok: any, body: "42" },
    "GET /metadata/v1/interfaces/public/0/ipv4/address": { ok: any, body: "203.0.113.4" },
  },
  hetzner: {
    "GET /hetzner/v1/metadata/instance-id": { ok: any, body: "7" },
    "GET /hetzner/v1/metadata/public-ipv4": { ok: any, body: "203.0.113.5" },
  },
  oracle: {
    "GET /opc/v2/instance/id": { ok: (h) => h.authorization === "Bearer Oracle", body: "ocid1" },
  },
};
const EXPECTED_IP = {
  aws: "203.0.113.1",
  gcp: "203.0.113.2",
  azure: "203.0.113.3",
  digitalocean: "203.0.113.4",
  hetzner: "203.0.113.5",
  oracle: "",
};

const emptyDmi = () => mkdtempSync(join(tmpdir(), "ratel-dmi-"));
const detect = (env) =>
  sh('cloud=$(detect_cloud)\nprintf "%s|%s\\n" "$cloud" "$(public_ip "$cloud")"', { env });

for (const [provider, routes] of Object.entries(PROVIDERS)) {
  test(`detect_cloud finds ${provider} from its metadata service, and its public IP`, async () => {
    const service = await metadata(routes);
    try {
      const { stdout } = await detect({ RATEL_METADATA_URL: service.url, RATEL_DMI_DIR: emptyDmi() });
      assert.equal(stdout.trim(), `${provider}|${EXPECTED_IP[provider]}`);
    } finally {
      service.close();
    }
  });
}

test("detect_cloud reads DMI first, with no network call", async () => {
  const cases = {
    aws: { sys_vendor: "Amazon EC2" },
    gcp: { product_name: "Google Compute Engine" },
    azure: { sys_vendor: "Microsoft Corporation", chassis_asset_tag: "7783-7084-3265-9085-8269-3286-77" },
    digitalocean: { sys_vendor: "DigitalOcean" },
    hetzner: { sys_vendor: "Hetzner" },
    oracle: { chassis_asset_tag: "OracleCloud.com" },
  };
  for (const [provider, files] of Object.entries(cases)) {
    const dmi = emptyDmi();
    for (const [name, value] of Object.entries(files)) writeFileSync(join(dmi, name), `${value}\n`);
    const { stdout } = await sh("detect_cloud", {
      env: { RATEL_METADATA_URL: "http://127.0.0.1:9", RATEL_DMI_DIR: dmi },
    });
    assert.equal(stdout.trim(), provider);
  }
});

test("detect_cloud says local when no metadata service answers", async () => {
  const { stdout } = await detect({ RATEL_METADATA_URL: "http://127.0.0.1:9", RATEL_DMI_DIR: emptyDmi() });
  assert.equal(stdout.trim(), "local|");
});

const envFile = (dir) => readFileSync(join(dir, ".env"), "utf8");
const value = (text, name) => text.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1];
const checkout = () => {
  const dir = mkdtempSync(join(tmpdir(), "ratel-checkout-"));
  writeFileSync(join(dir, ".env.example"), readFileSync(EXAMPLE));
  return dir;
};

test("write_env fills every server secret with a fresh random value and prints none", async () => {
  const dir = checkout();
  const { stdout } = await sh(`write_env "${dir}"`);
  const text = envFile(dir);
  const secrets = ["POSTGRES_PASSWORD", "TRACE_SIGNALS_HASH_SALT", "CRON_SECRET"].map((name) => {
    const secret = value(text, name);
    assert.match(secret ?? "", /^[0-9a-f]{64}$/, name);
    assert.ok(!stdout.includes(secret), `${name} is not printed`);
    return secret;
  });
  assert.equal(new Set(secrets).size, secrets.length);
  assert.equal(statSync(join(dir, ".env")).mode & 0o777, 0o600, "only the owner reads .env");
  assert.equal(value(text, "BASE_URL"), "http://localhost:3000", "the rest of .env.example stays");

  const other = checkout();
  await sh(`write_env "${other}"`);
  assert.notEqual(value(envFile(other), "POSTGRES_PASSWORD"), secrets[0]);
});

test("write_env never overwrites an existing .env", async () => {
  const dir = checkout();
  writeFileSync(join(dir, ".env"), "POSTGRES_PASSWORD=mine\n");
  const { code } = await sh(`write_env "${dir}"`);
  assert.equal(code, 0);
  assert.equal(envFile(dir), "POSTGRES_PASSWORD=mine\n");
});

test("default_dir is ~/ratel for a user", async () => {
  const home = mkdtempSync(join(tmpdir(), "ratel-home-"));
  const { stdout } = await sh("default_dir", { env: { HOME: home } });
  assert.equal(stdout.trim(), process.getuid?.() === 0 ? "/opt/ratel" : `${home}/ratel`);
});
