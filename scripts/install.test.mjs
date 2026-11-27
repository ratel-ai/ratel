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
  sh('parse_args "$@"\nprintf "%s|%s|%s|%s\\n" "${REF:-$VERSION}" "$INSTALL_DIR" "$ASSUME_YES" "$WITH_DEMO"', {
    args,
    env,
  });
const access = (args, env) =>
  sh('parse_args "$@"\nprintf "%s|%s|%s|%s\\n" "$ACCESS" "$DOMAIN" "$TLS" "$AUTH_HASH"', { args, env });

test("parse_args defaults to the latest release, ~/ratel, interactive and no demo", async () => {
  const { stdout } = await parsed([]);
  assert.match(stdout.trim(), /^latest\|\/.+\/ratel\|0\|0$/);
  assert.doesNotMatch(stdout, /\/opt\/ratel/);
});

test("parse_args reads every flag, in both spellings", async () => {
  const spaced = await parsed(["--ref", "feat/x", "--dir", "/srv/r", "--yes", "--demo"]);
  assert.equal(spaced.stdout.trim(), "feat/x|/srv/r|1|1");
  const joined = await parsed(["--ref=abc123", "--dir=/x", "-y"]);
  assert.equal(joined.stdout.trim(), "abc123|/x|1|0");
});

test("parse_args takes the same settings from the environment, flags win", async () => {
  const env = { RATEL_REF: "dev", RATEL_DIR: "/e", RATEL_YES: "1", RATEL_DEMO: "1" };
  assert.equal((await parsed([], env)).stdout.trim(), "dev|/e|1|1");
  assert.equal((await parsed(["--ref", "flag"], env)).stdout.trim(), "flag|/e|1|1");
});

const target = (args, env) => sh('parse_args "$@"\nprintf "%s|%s\\n" "$VERSION" "$REF"', { args, env });

test("parse_args takes a release as --version, or as --ref vX.Y.Z", async () => {
  for (const args of [["--version", "0.3.0"], ["--version=v0.3.0"], ["--ref", "v0.3.0"]]) {
    assert.equal((await target(args)).stdout.trim(), "0.3.0|", args.join(" "));
  }
  assert.equal((await target(["--version", "edge"])).stdout.trim(), "edge|");
  assert.equal((await target(["--ref=v0.3.0-rc.1"])).stdout.trim(), "0.3.0-rc.1|");
  assert.equal((await target([], { RATEL_VERSION: "0.3.0" })).stdout.trim(), "0.3.0|");
});

test("parse_args takes every other ref as a source build, an SDK tag too", async () => {
  for (const ref of ["main", "feat/x", "6e8ce216", "sdk-ts-v0.13.0"]) {
    assert.equal((await target(["--ref", ref])).stdout.trim(), `|${ref}`, ref);
  }
});

test("parse_args: a flag wins over the other setting's variable, and both flags are an error", async () => {
  assert.equal((await target(["--ref", "main"], { RATEL_VERSION: "0.3.0" })).stdout.trim(), "|main");
  assert.equal((await target(["--version", "0.3.0"], { RATEL_REF: "main" })).stdout.trim(), "0.3.0|");
  assert.equal((await target(["--version", "0.3.0", "--ref", "main"])).code, 2);
  for (const bad of ["0.3", "main", "0.3.0;id", "0.3.0/x"]) assert.equal((await target(["--version", bad])).code, 2, bad);
});

test("parse_args keeps RATEL_VERSION out of docker compose, which reads .env", async () => {
  const { stdout } = await sh('parse_args\necho "${RATEL_VERSION-unset}"', { env: { RATEL_VERSION: "v0.3.0" } });
  assert.equal(stdout.trim(), "unset");
});

/** Docker Hub's tag API for one repository with these tags. */
const hub = async (tags) => {
  const server = createServer((req, res) => {
    const { pathname } = new URL(req.url, "http://hub");
    const results = tags.map((name) => ({ name, images: [{ architecture: "amd64" }, { architecture: "arm64" }] }));
    if (pathname === "/tags") res.writeHead(200).end(JSON.stringify({ count: tags.length, results }));
    else if (tags.includes(pathname.replace("/tags/", ""))) res.writeHead(200).end("{}");
    else res.writeHead(404).end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
};
const resolved = async (args, tags) => {
  const service = await hub(tags);
  try {
    return await sh('parse_args "$@"\nresolve_version >&2\nprintf "%s|%s\\n" "$VERSION" "$(git_ref)"', {
      args,
      env: { RATEL_HUB_URL: service.url },
    });
  } finally {
    service.close();
  }
};

test("resolve_version takes the highest published X.Y.Z, not a moving tag or a pre-release", async () => {
  const tags = ["edge", "latest", "0.9", "0.10", "0.9.2", "0.10.1", "0.10.0", "0.11.0-rc.1", "0.0.0-test"];
  assert.equal((await resolved([], tags)).stdout.trim(), "0.10.1|v0.10.1");
  assert.equal((await resolved(["--version", "latest"], tags)).stdout.trim(), "0.10.1|v0.10.1");
});

test("resolve_version never takes an SDK tag: v0.2.0 is one, and it has no image", async () => {
  const { code, stderr } = await resolved(["--ref", "v0.2.0"], ["0.4.0", "latest"]);
  assert.equal(code, 1);
  assert.match(stderr, /0\.2\.0 is not a published Ratel release/);
  assert.equal((await resolved([], ["0.4.0", "sdk-ts-v0.13.0", "v0.2.0"])).stdout.trim(), "0.4.0|v0.4.0");
});

test("resolve_version takes a published pre-release or edge when asked, and edge reads main", async () => {
  assert.equal((await resolved(["--version", "0.5.0-rc.1"], ["0.5.0-rc.1"])).stdout.trim(), "0.5.0-rc.1|v0.5.0-rc.1");
  assert.equal((await resolved(["--version", "edge"], ["edge"])).stdout.trim(), "edge|main");
});

test("resolve_version builds main while no release is published, and leaves a --ref alone", async () => {
  assert.equal((await resolved([], ["edge"])).stdout.trim(), "|main");
  assert.equal((await resolved(["--ref", "feat/x"], ["0.4.0"])).stdout.trim(), "|feat/x");
});

test("resolve_version stops when Docker Hub does not answer, rather than build main", async () => {
  const { code, stderr } = await sh("parse_args\nresolve_version", { env: { RATEL_HUB_URL: "http://127.0.0.1:9" } });
  assert.equal(code, 1);
  assert.match(stderr, /--version/);
});

/** A bare origin with a v0.4.0 and a v0.5.0 release on main, and main one commit ahead. */
const origin = async () => {
  const dir = mkdtempSync(join(tmpdir(), "ratel-origin-"));
  await run("sh", [
    "-ec",
    `cd "${dir}" && git init -q -b main . && git config user.email t@example.com && git config user.name t
     image() { echo 'image: ratelai/ratel:x' > docker-compose.yml; }
     image; git add . && git commit -qm one && git tag v0.4.0
     echo 2 > f; git add . && git commit -qm two && git tag v0.5.0
     echo 3 > f; git add . && git commit -qm three`,
  ]);
  return dir;
};
const fetched = async (repo, dir, args) =>
  sh('parse_args "$@"\nfetch_source\ngit describe --tags --always', {
    args: [...args, "--dir", dir],
    env: { RATEL_REPO: repo },
  });

test("fetch_source checks out a release's tag, and upgrades a source checkout to it", async () => {
  const repo = await origin();
  const dir = join(mkdtempSync(join(tmpdir(), "ratel-dir-")), "ratel");
  assert.match((await fetched(repo, dir, ["--version", "0.4.0"])).stdout, /v0\.4\.0\n$/);
  assert.match((await fetched(repo, dir, ["--version", "0.5.0"])).stdout, /v0\.5\.0\n$/);
});

test("fetch_source refuses a release older than the checkout, unless --allow-downgrade", async () => {
  const repo = await origin();
  const dir = join(mkdtempSync(join(tmpdir(), "ratel-dir-")), "ratel");
  await fetched(repo, dir, ["--ref", "main"]);
  const refused = await fetched(repo, dir, ["--version", "0.5.0"]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /newer than v0\.5\.0/);
  const forced = await fetched(repo, dir, ["--version", "0.5.0", "--allow-downgrade"]);
  assert.match(forced.stdout, /v0\.5\.0\n$/);
});

/** An installed directory with the compose files, as fetch_source leaves it. */
const installed = (files = ["docker-compose.yml", "docker-compose.build.yml"], composeText = "image: ratelai/ratel:x\n") => {
  const dir = mkdtempSync(join(tmpdir(), "ratel-installed-"));
  for (const file of files) writeFileSync(join(dir, file), composeText);
  writeFileSync(join(dir, ".env"), "POSTGRES_PASSWORD=mine\nRATEL_VERSION=0.1.0\nCOMPOSE_FILE=old\n");
  return dir;
};
const configured = async (dir, setup) => {
  await sh(`${setup}\nconfigure_compose "${dir}" >/dev/null`);
  const text = envFile(dir);
  return [value(text, "RATEL_VERSION"), value(text, "COMPOSE_FILE"), value(text, "POSTGRES_PASSWORD")];
};

test("configure_compose pins a release in .env and keeps the rest", async () => {
  assert.deepEqual(await configured(installed(), "VERSION=0.4.0 ACCESS=private"), ["0.4.0", undefined, "mine"]);
  assert.deepEqual(await configured(installed(), "VERSION=0.4.0 ACCESS=public"), [
    "0.4.0",
    "docker-compose.yml:docker-compose.caddy.yml",
    "mine",
  ]);
});

test("configure_compose adds the build override for a source build and pins no version", async () => {
  const build = "docker-compose.yml:docker-compose.build.yml";
  assert.deepEqual(await configured(installed(), "VERSION= REF=main ACCESS=private"), [undefined, build, "mine"]);
  assert.deepEqual(await configured(installed(), "VERSION= REF=main ACCESS=public"), [
    undefined,
    `${build}:docker-compose.caddy.yml`,
    "mine",
  ]);
});

test("configure_compose builds a ref or a release from before docker-compose.build.yml", async () => {
  const old = () => installed(["docker-compose.yml"], "build: .\n");
  assert.deepEqual(await configured(old(), "VERSION= REF=old ACCESS=private"), [undefined, undefined, "mine"]);
  const { stdout } = await sh(`VERSION=0.1.0 ACCESS=private\nconfigure_compose "${old()}" >/dev/null 2>&1\necho "$VERSION"`);
  assert.equal(stdout, "\n", "started as a source build");
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
  const secrets = ["POSTGRES_PASSWORD", "TRACE_SIGNALS_HASH_SALT", "RATEL_SECRET_KEY", "CRON_SECRET"].map((name) => {
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
