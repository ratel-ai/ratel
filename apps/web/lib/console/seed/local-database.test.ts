import assert from "node:assert/strict";
import { test } from "node:test";
import { assertLocalDatabase, localDatabaseProblem } from "@/lib/console/seed/local-database";

const local = (url: string, env: Record<string, string | undefined> = {}) =>
  localDatabaseProblem(url, env) === null;

test("this machine only: localhost, 127.0.0.1 and ::1, in any case", () => {
  assert.ok(local("postgres://ratel:ratel@localhost:5432/ratel"));
  assert.ok(local("postgresql://ratel:ratel@127.0.0.1/ratel?sslmode=disable"));
  assert.ok(local("postgres://ratel:ratel@[::1]:5432/ratel"));
  assert.ok(local("postgres://ratel:ratel@LOCALHOST:5432/ratel"), "hosts are not case-sensitive");
  assert.ok(local("postgres://localhost/ratel"), "no credentials is fine");
});

test("another host is refused, however the URL hides it", () => {
  assert.match(
    localDatabaseProblem("postgres://u:p@prod.example.com:5432/ratel", {})!,
    /prod\.example\.com/,
  );
  assert.equal(
    local("postgres://u:p@db:5432/ratel"),
    false,
    "a compose service name is another machine",
  );
  assert.equal(
    local("postgres://u:p@localhost:5432/ratel?host=prod.rds.amazonaws.com"),
    false,
    "?host= overrides the authority",
  );
  assert.equal(local("postgres://u:p@localhost/ratel?hostaddr=10.0.0.4"), false);
  assert.equal(local("postgres://u:p@localhost/ratel?port=6543"), false);
  assert.equal(
    local("postgres://u:p@localhost/ratel?HOST=prod.example.com"),
    false,
    "parameter names in any case",
  );
  assert.equal(
    local("postgres://u:p@localhost/ratel?service=prod"),
    false,
    "a service file can name any host",
  );
  assert.equal(
    local("postgres://u:p@prod.example.com/ratel?application_name=x@localhost/"),
    false,
    "an @localhost later in the URL is not the host",
  );
  assert.equal(local("postgres://u:p@localhost.example.com/ratel"), false);
  assert.equal(local("postgres://u:p@127.0.0.1.nip.io/ratel"), false);
  assert.equal(local("postgres://u:p@localhost:5432,prod:5432/ratel"), false, "several hosts");
  assert.equal(local("postgres:///ratel"), false, "no host at all");
  assert.equal(local("mysql://u:p@localhost/ratel"), false);
  assert.equal(local("not a url"), false);
  assert.equal(localDatabaseProblem(undefined, {}), "DATABASE_URL is not set");
});

test("PGHOST and PGHOSTADDR must stay on this machine too", () => {
  const url = "postgres://ratel:ratel@localhost:5432/ratel";
  assert.ok(local(url, { PGHOST: "localhost" }));
  assert.ok(local(url, { PGHOST: "/var/run/postgresql" }), "a socket directory is local");
  assert.ok(local(url, { PGHOSTADDR: "127.0.0.1", PGHOST: "" }));
  assert.match(
    localDatabaseProblem(url, { PGHOST: "prod.example.com" })!,
    /PGHOST is set to prod\.example\.com/,
  );
  assert.equal(local(url, { PGHOST: "localhost,prod.example.com" }), false, "every listed host");
  assert.equal(local(url, { PGHOSTADDR: "10.1.2.3" }), false);
  assert.equal(local(url, { PGHOSTADDR: "/tmp" }), false, "an address is never a socket");
});

test("the assertion names what it refused to do", () => {
  assert.throws(
    () =>
      assertLocalDatabase("seed intents", {
        DATABASE_URL: "postgres://u:p@prod.example.com/ratel",
      }),
    /^Error: refusing to seed intents: DATABASE_URL points at prod\.example\.com, not this machine\./,
  );
  assert.doesNotThrow(() =>
    assertLocalDatabase("seed intents", { DATABASE_URL: "postgres://u:p@localhost/ratel" }),
  );
});
