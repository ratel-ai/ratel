import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const compose = read("docker-compose.yml");
const example = Object.fromEntries(
  read(".env.example")
    .split("\n")
    .filter((line) => /^[A-Z_]+=/.test(line))
    .map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at), line.slice(at + 1)];
    }),
);

test("every default in docker-compose.yml matches .env.example", () => {
  const defaults = [...compose.matchAll(/\$\{([A-Z_]+):-([^}]*)\}/g)];
  assert.ok(defaults.length > 0);
  for (const [, name, value] of defaults) {
    assert.ok(name in example, `${name} is not in .env.example`);
    assert.equal(example[name], value, name);
  }
});

test("web, worker and demo run the published images, and only the override builds", () => {
  const image = (name) => new RegExp(`image: ratelai/${name}:\\$\\{RATEL_VERSION:-\\d+\\.\\d+\\.\\d+\\} # x-release-please-version\\n`);
  assert.match(compose.slice(0, compose.indexOf("\nservices:")), image("ratel"));
  assert.match(service("demo"), image("ratel-demo"));
  assert.doesNotMatch(compose, /build:/);
  const build = read("docker-compose.build.yml");
  for (const name of ["web", "worker", "demo"]) assert.match(build, new RegExp(`\\n  ${name}:\\n    image: ratel-${name}\\n    build:`));
});

test("a release moves the default version in docker-compose.yml and .env.example", () => {
  const files = JSON.parse(read("release-please-config.json")).packages["."]["extra-files"];
  for (const path of ["docker-compose.yml", ".env.example"]) {
    assert.ok(files.some((file) => file.type === "generic" && file.path === path), path);
  }
  assert.match(read(".env.example"), /# x-release-please-start-version\nRATEL_VERSION=\d+\.\d+\.\d+\n# x-release-please-end\n/);
});

test("every published port stays on localhost", () => {
  const ports = [...compose.matchAll(/ports:\s*\[([^\]]*)\]/g)].map((match) => match[1]);
  assert.equal(ports.length, 2);
  for (const port of ports) assert.match(port, /^"127\.0\.0\.1:/);
});

test("the demo service reaches the database as localhost and gets no model key", () => {
  const demo = compose.slice(compose.indexOf("\n  demo:"), compose.indexOf("\nvolumes:"));
  assert.match(demo, /network_mode: service:db/);
  assert.match(demo, /DATABASE_URL: postgres:\/\/ratel:[^@]+@localhost:5432\/ratel/);
  assert.doesNotMatch(demo, /env_file|API_KEY/);
});

/** One service's block: from its key to the next service (or the volumes). */
const service = (name) => {
  const start = compose.indexOf(`\n  ${name}:`);
  assert.ok(start >= 0, `${name} is a service`);
  const next = compose.slice(start + 1).search(/\n {2}[a-z]+:\n|\nvolumes:/);
  return compose.slice(start, start + 1 + next);
};

test("web only queues jobs and migrates; the worker runs them, unpublished, and never migrates", () => {
  const web = service("web");
  assert.match(web, /<<: \*platform\n/);
  assert.match(web, /APP_ROLE: api/);
  assert.match(web, /DATABASE_MIGRATE_ON_BOOT: "1"/);

  const worker = service("worker");
  assert.match(worker, /<<: \*platform\n/, "the same image and env file as web");
  assert.match(worker, /APP_ROLE: worker/);
  assert.match(worker, /NEXT_MANUAL_SIG_HANDLE: "true"/, "a stop waits for the step in flight");
  assert.match(worker, /web:\n\s+condition: service_healthy/, "starts once web has migrated");
  assert.doesNotMatch(worker, /ports:/);
  assert.doesNotMatch(worker, /DATABASE_MIGRATE_ON_BOOT/);
});

test("db, web and worker come back after a reboot, and the demo does not", () => {
  const anchor = compose.slice(compose.indexOf("x-platform:"), compose.indexOf("\nservices:"));
  assert.match(anchor, /\n {2}restart: unless-stopped\n/, "web and worker inherit it");
  assert.match(service("db"), /\n {4}restart: unless-stopped\n/);
  assert.doesNotMatch(service("demo"), /restart:/, "a one-shot seed");
});
