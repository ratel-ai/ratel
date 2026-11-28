import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfig } from "@/config";
import {
  sandboxDeploymentId,
  sandboxProvider,
  sandboxProviderConfigured,
  sandboxProviderKind,
} from "../adapters/provider-from-env";

const idOf = (env: Record<string, string>) => sandboxDeploymentId(resolveConfig({ env }));

test("the deployment id is SANDBOX_DEPLOYMENT_ID when it is set", () => {
  assert.equal(
    idOf({ SANDBOX_DEPLOYMENT_ID: "staging-eu", APP_PUBLIC_URL: "https://a.example" }),
    "staging-eu",
  );
});

test("with no SANDBOX_DEPLOYMENT_ID, the id comes from the public URL, else the base URL, and is stable", () => {
  const prod = idOf({ APP_PUBLIC_URL: "https://ratel.example" });
  assert.match(prod, /^[a-f0-9]{16}$/);
  assert.equal(idOf({ APP_PUBLIC_URL: "https://ratel.example" }), prod);
  assert.notEqual(idOf({ APP_PUBLIC_URL: "https://staging.ratel.example" }), prod);
  assert.notEqual(idOf({ BASE_URL: "http://localhost:3001" }), idOf({}));
});

test("a SANDBOX_DEPLOYMENT_ID that is not a plain label value is refused", () => {
  assert.throws(() => idOf({ SANDBOX_DEPLOYMENT_ID: "has space=1" }), /SANDBOX_DEPLOYMENT_ID/);
});

const kindOf = (env: Record<string, string>, nodeEnv = "development") =>
  sandboxProviderKind(resolveConfig({ env }), nodeEnv);

test("SANDBOX_PROVIDER=local-docker picks the local Docker provider outside production", () => {
  assert.deepEqual(kindOf({ SANDBOX_PROVIDER: "local-docker" }), { kind: "local-docker" });
  assert.deepEqual(kindOf({ SANDBOX_PROVIDER: "local-docker" }, "test"), { kind: "local-docker" });
  const config = resolveConfig({ env: { SANDBOX_PROVIDER: "local-docker" } });
  assert.ok(sandboxProvider(config, "development"));
  assert.equal(sandboxProviderConfigured(config, "development"), true);
});

test("local-docker is refused in production, and the provider is not set up", () => {
  const refused = kindOf({ SANDBOX_PROVIDER: "local-docker", BOAT_API_KEY: "k" }, "production");
  assert.equal(refused.kind, "refused");
  const config = resolveConfig({ env: { SANDBOX_PROVIDER: "local-docker" } });
  assert.equal(sandboxProvider(config, "production"), null);
  assert.equal(sandboxProviderConfigured(config, "production"), false);
});

test("local-docker is refused in the Cloud composition, also outside production", () => {
  const env = { SANDBOX_PROVIDER: "local-docker", RATEL_COMPOSITION: "cloud" };
  assert.equal(kindOf(env).kind, "refused");
  assert.equal(sandboxProvider(resolveConfig({ env }), "development"), null);
});

test("BOAT_API_KEY with no SANDBOX_PROVIDER picks boat; nothing set is no provider", () => {
  assert.deepEqual(kindOf({ BOAT_API_KEY: "k" }), { kind: "boat" });
  assert.deepEqual(kindOf({ BOAT_API_KEY: "k" }, "production"), { kind: "boat" });
  assert.deepEqual(kindOf({ SANDBOX_PROVIDER: "boat", BOAT_API_KEY: "k" }), { kind: "boat" });
  assert.deepEqual(kindOf({}), { kind: "none" });
  assert.deepEqual(kindOf({ SANDBOX_PROVIDER: "boat" }), { kind: "none" });
  assert.equal(sandboxProvider(resolveConfig({ env: {} }), "development"), null);
});

test("a SANDBOX_PROVIDER that is not known is refused by the config", () => {
  assert.throws(() => kindOf({ SANDBOX_PROVIDER: "kubernetes" }), /SANDBOX_PROVIDER/);
});
