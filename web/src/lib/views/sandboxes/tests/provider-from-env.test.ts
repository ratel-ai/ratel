import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfig } from "@/config";
import { sandboxDeploymentId } from "../adapters/provider-from-env";

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
