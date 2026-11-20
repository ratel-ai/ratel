import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
const access = (args, env) =>
  sh('parse_args "$@"\nprintf "%s|%s|%s|%s\\n" "$ACCESS" "$DOMAIN" "$TLS" "$AUTH_HASH"', { args, env });

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

test("parse_args rejects a ref with .. (it goes into a git ref path)", async () => {
  for (const ref of ["main/../../evil", "..", "a..b"]) assert.equal((await parsed(["--ref", ref])).code, 2, ref);
});

test("parse_args leaves the access settings empty by default, so a rerun keeps the last ones", async () => {
  assert.equal((await access([])).stdout.trim(), "|||");
});

test("parse_args reads the access flags and their environment variables", async () => {
  const hash = "$2a$14$abcdefghijklmnopqrstuuJ0123456789ABCDEFGHIJKLMNOPQRSTU";
  const flags = ["--access", "public", "--domain", "ratel.example.com", "--tls", "internal", "--auth-hash", hash];
  assert.equal((await access(flags)).stdout.trim(), `public|ratel.example.com|internal|${hash}`);
  assert.equal((await access(["--access=private"])).stdout.trim(), "private|||");
  const env = { RATEL_ACCESS: "public", RATEL_DOMAIN: "d.example", RATEL_TLS: "acme", RATEL_AUTH_HASH: hash };
  assert.equal((await access([], env)).stdout.trim(), `public|d.example|acme|${hash}`);
});

test("parse_args rejects a bad access mode, TLS mode, domain or hash", async () => {
  for (const args of [
    ["--access", "open"],
    ["--tls", "selfsigned"],
    ["--domain", "bad domain"],
    ["--domain", "x;rm"],
    ["--auth-hash", "plain"],
  ]) {
    assert.equal((await access(args)).code, 2, args.join(" "));
  }
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

const HASH = "$2a$14$kM8gAcZngmeTKUfqyUYLq.3Q5QhNjZzwZYLJy0KOFd.dKMODiAy7e";
const caddyfile = (domain, hash, tls) => sh(`write_caddyfile '${domain}' '${hash}' '${tls}'`);
const OPEN_ROUTES = ["/v1", "/v2", "/api/v1", "/api/v2", "/api/mcp", "/api/health"];

test("write_caddyfile lets the API-key routes and /api/health pass without the login", async () => {
  const { stdout } = await caddyfile("ratel.example.com", HASH, "acme");
  const matcher = stdout.match(/^\t@open path (.+)$/m)?.[1].split(" ");
  assert.ok(matcher, "an @open path matcher");
  for (const route of OPEN_ROUTES) assert.ok(matcher.includes(route), route);
  for (const route of OPEN_ROUTES.filter((r) => r !== "/api/health")) {
    assert.ok(matcher.includes(`${route}/*`), `${route}/*`);
  }
  assert.ok(!matcher.includes("/api/health/*"), "only /api/health itself, as the README says");
  assert.ok(
    matcher.every((route) => !route.endsWith("*") || route.endsWith("/*")),
    "no prefix match such as /v1* that would also open /v1foo",
  );
  assert.match(stdout, /handle @open \{\n\t\treverse_proxy web:3000\n\t\}/);
});

test("write_caddyfile puts every other route behind basic auth with the bcrypt hash", async () => {
  const { stdout } = await caddyfile("ratel.example.com", HASH, "acme");
  assert.match(stdout, /^ratel\.example\.com \{$/m);
  const fallback = stdout.slice(stdout.indexOf("\thandle {"));
  assert.ok(fallback.indexOf("basic_auth") < fallback.indexOf("reverse_proxy"), "auth before the proxy");
  assert.ok(stdout.includes(`\t\t\tratel ${HASH}\n`));
  assert.doesNotMatch(stdout, /tls internal/);
});

test("write_caddyfile uses Caddy's own CA with --tls internal", async () => {
  const { stdout } = await caddyfile("10.0.0.5.sslip.io", HASH, "internal");
  assert.match(stdout, /^10\.0\.0\.5\.sslip\.io \{\n\ttls internal$/m);
});

test("caddy_setting reads the domain, hash and TLS mode back from a written Caddyfile", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ratel-caddy-"));
  const file = join(dir, "Caddyfile");
  for (const tls of ["acme", "internal"]) {
    await sh(`write_caddyfile ratel.example.com '${HASH}' ${tls} > "${file}"`);
    const { stdout } = await sh(
      `printf '%s|%s|%s\\n' "$(caddy_setting domain "${file}")" "$(caddy_setting hash "${file}")" "$(caddy_setting tls "${file}")"`,
    );
    assert.equal(stdout.trim(), `ratel.example.com|${HASH}|${tls}`);
  }
  const { stdout } = await sh(`caddy_setting domain "${join(dir, "missing")}"`);
  assert.equal(stdout, "");
});

test("set_env_line replaces or removes one variable and keeps every other line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ratel-env-"));
  const file = join(dir, ".env");
  writeFileSync(file, "A=1\nCOMPOSE_FILE=old\nB=2\n");
  await sh(`set_env_line "${file}" COMPOSE_FILE docker-compose.yml:docker-compose.caddy.yml`);
  assert.equal(readFileSync(file, "utf8"), "A=1\nB=2\nCOMPOSE_FILE=docker-compose.yml:docker-compose.caddy.yml\n");
  await sh(`set_env_line "${file}" COMPOSE_FILE ""`);
  assert.equal(readFileSync(file, "utf8"), "A=1\nB=2\n");
  writeFileSync(file, "A=1\nB=2\n");
  chmodSync(file, 0o600);
  await sh(`set_env_line "${file}" COMPOSE_FILE ""`);
  assert.equal(readFileSync(file, "utf8"), "A=1\nB=2\n");
  assert.equal(statSync(file).mode & 0o777, 0o600, "the mode stays owner-only");
});

test("the Caddy overlay mounts the generated Caddyfile and publishes only 80 and 443", () => {
  const overlay = readFileSync(fileURLToPath(new URL("../docker-compose.caddy.yml", import.meta.url)), "utf8");
  assert.match(overlay, /- \.\/Caddyfile:\/etc\/caddy\/Caddyfile:ro/);
  const ports = overlay.match(/ports: \[([^\]]*)\]/)?.[1];
  assert.equal(ports, '"80:80", "443:443"');
  const image = overlay.match(/image: (caddy:\S+)/)?.[1];
  assert.ok(readFileSync(SCRIPT, "utf8").includes(`CADDY_IMAGE=${image}`), "install.sh hashes with the same image");
});
