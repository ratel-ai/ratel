import assert from "node:assert/strict";
import { test } from "node:test";
import { configuredOrganizationName, exposureWarnings } from "./deployment-config";

test("the organization name is trimmed, and blank means none", () => {
  assert.equal(configuredOrganizationName({ RATEL_ORG_NAME: "  Acme  " }), "Acme");
  assert.equal(configuredOrganizationName({ RATEL_ORG_NAME: "   " }), null);
  assert.equal(configuredOrganizationName({}), null);
});

test("a name over the limit throws and names the variable", () => {
  assert.throws(
    () => configuredOrganizationName({ RATEL_ORG_NAME: "x".repeat(61) }),
    /^Error: RATEL_ORG_NAME: /,
  );
  assert.equal(configuredOrganizationName({ RATEL_ORG_NAME: "x".repeat(60) }), "x".repeat(60));
});

test("the Cloud composition ignores the organization name", () => {
  assert.equal(
    configuredOrganizationName({ RATEL_COMPOSITION: "cloud", RATEL_ORG_NAME: "Acme" }),
    null,
  );
});

const PUBLIC_URL = "https://ratel.example.com/api/v1";
const OWN_PASSWORD = "postgres://ratel:0123abcd@db:5432/ratel";

test("a local deployment warns about nothing, whatever its secrets", () => {
  const local = { DATABASE_URL: "postgres://ratel:ratel@db:5432/ratel" };
  assert.deepEqual(exposureWarnings(local), []);
  for (const BASE_URL of [
    "http://localhost:3000/api/v1",
    "http://127.0.0.1:3000/api/v1",
    "http://[::1]:3000/api/v1",
  ]) {
    assert.deepEqual(exposureWarnings({ ...local, BASE_URL }), []);
  }
});

test("a public URL with its own secrets warns about nothing", () => {
  assert.deepEqual(
    exposureWarnings({
      BASE_URL: PUBLIC_URL,
      DATABASE_URL: OWN_PASSWORD,
      TRACE_SIGNALS_HASH_SALT: "0123abcd",
    }),
    [],
  );
});

test("a public URL warns about the default password and never repeats a secret", () => {
  const warnings = exposureWarnings({
    BASE_URL: PUBLIC_URL,
    DATABASE_URL: "postgres://ratel:ratel@db:5432/ratel",
    TRACE_SIGNALS_HASH_SALT: "s3cret-salt",
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /POSTGRES_PASSWORD/);
  assert.doesNotMatch(warnings[0], /s3cret-salt/);
});

test("a public URL warns about a missing or placeholder salt", () => {
  for (const salt of [undefined, "  ", "REPLACE_ME"]) {
    const warnings = exposureWarnings({
      BASE_URL: PUBLIC_URL,
      DATABASE_URL: OWN_PASSWORD,
      TRACE_SIGNALS_HASH_SALT: salt,
    });
    assert.equal(warnings.length, 1, String(salt));
    assert.match(warnings[0], /TRACE_SIGNALS_HASH_SALT/);
  }
});

test("an unparsable URL warns about nothing, and the Cloud composition is left alone", () => {
  assert.deepEqual(
    exposureWarnings({ BASE_URL: "not a url", DATABASE_URL: "postgres://ratel:ratel@db/r" }),
    [],
  );
  assert.deepEqual(exposureWarnings({ RATEL_COMPOSITION: "cloud", BASE_URL: PUBLIC_URL }), []);
});
