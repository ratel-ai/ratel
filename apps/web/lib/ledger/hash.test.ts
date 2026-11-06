import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEV_TRACE_SIGNALS_HASH_SALT,
  hashEndUser,
  hashQuery,
  traceSignalsHashSalt,
} from "@/lib/ledger/hash";

test("queries hash through the answer key's normalization", () => {
  assert.equal(hashQuery("  Assign  the TASK ", "s"), hashQuery("assign the task", "s"));
  assert.notEqual(hashQuery("assign the task", "s"), hashQuery("assign the task", "other"));
  assert.equal(hashQuery("   ", "s"), null);
  assert.equal(hashQuery(null, "s"), null);
});

test("a query and an end-user id with the same text never collide", () => {
  assert.notEqual(hashQuery("alice", "s"), hashEndUser("alice", "s"));
  assert.equal(hashEndUser("", "s"), null);
  assert.match(hashEndUser("alice", "s") ?? "", /^[0-9a-f]{32}$/);
});

test("the salt comes from the environment with a development fallback", () => {
  assert.equal(traceSignalsHashSalt({ TRACE_SIGNALS_HASH_SALT: "prod-salt" }), "prod-salt");
  assert.equal(
    traceSignalsHashSalt({ APP_ENV: "production", TRACE_SIGNALS_HASH_SALT: "prod-salt" }),
    "prod-salt",
  );
  assert.equal(
    traceSignalsHashSalt({}),
    DEV_TRACE_SIGNALS_HASH_SALT,
    "unset APP_ENV is development",
  );
  for (const appEnv of ["development", "local", "test", "Test"]) {
    assert.equal(traceSignalsHashSalt({ APP_ENV: appEnv }), DEV_TRACE_SIGNALS_HASH_SALT, appEnv);
  }
});

test("a deployed environment never falls back to the committed salt", () => {
  for (const appEnv of ["production", "staging", "preview"]) {
    assert.equal(traceSignalsHashSalt({ APP_ENV: appEnv }), null, appEnv);
    assert.equal(traceSignalsHashSalt({ APP_ENV: appEnv, TRACE_SIGNALS_HASH_SALT: "  " }), null);
    assert.equal(
      traceSignalsHashSalt({ APP_ENV: appEnv, TRACE_SIGNALS_HASH_SALT: "REPLACE_ME" }),
      null,
      "the Terraform seed is not a salt",
    );
  }
});
