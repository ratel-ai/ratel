import assert from "node:assert/strict";
import { test } from "node:test";
import { isLocalEnvironment, resolvePublicEnv, serializePublicEnv } from "./environment";

test("the public env carries the environment label and nothing else", () => {
  assert.deepEqual(
    resolvePublicEnv({ APP_ENV: "staging", DATABASE_URL: "secret", OPENAI_API_KEY: "sk" }),
    { environment: "staging" },
  );
  assert.deepEqual(resolvePublicEnv({}), { environment: "development" });
});

test("local environments are an allowlist", () => {
  assert.equal(isLocalEnvironment({}), true);
  assert.equal(isLocalEnvironment({ APP_ENV: "Test" }), true);
  assert.equal(isLocalEnvironment({ APP_ENV: "production" }), false);
  assert.equal(isLocalEnvironment({ APP_ENV: "preview" }), false);
});

test("serialization escapes a closing script tag", () => {
  assert.equal(serializePublicEnv({ environment: "</script>" }).includes("</script>"), false);
});
