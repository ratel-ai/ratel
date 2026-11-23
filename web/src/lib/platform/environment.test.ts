import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfig } from "@/config";
import { isLocalEnvironment, resolvePublicEnv, serializePublicEnv } from "./environment";

test("the public env carries the environment label and nothing else", () => {
  assert.deepEqual(
    resolvePublicEnv(
      resolveConfig({ env: { APP_ENV: "staging", DATABASE_URL: "secret", OPENAI_API_KEY: "sk" } }),
    ),
    { environment: "staging" },
  );
  assert.deepEqual(resolvePublicEnv(resolveConfig()), { environment: "development" });
});

test("local environments are an allowlist", () => {
  assert.equal(isLocalEnvironment(resolveConfig().app.environment), true);
  assert.equal(isLocalEnvironment("Test"), true);
  assert.equal(isLocalEnvironment("production"), false);
  assert.equal(isLocalEnvironment("preview"), false);
});

test("serialization escapes a closing script tag", () => {
  assert.equal(serializePublicEnv({ environment: "</script>" }).includes("</script>"), false);
});
