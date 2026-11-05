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
