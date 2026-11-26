import assert from "node:assert/strict";
import { test } from "node:test";
import { SANDBOX_HARD_LIMITS } from "@/lib/contracts/usage-limits";
import nextConfig from "../../../../../next.config";

// With a proxy (an edition's web/src/proxy.ts), Next keeps only the first 10 MB of a request body
// by default, so `PUT .../bundle` of a larger bundle was cut and refused as `bundle_mismatch`.
test("the proxy body limit takes the largest bundle that a push may upload", () => {
  assert.ok(
    Number(nextConfig.experimental?.proxyClientMaxBodySize) >=
      SANDBOX_HARD_LIMITS.sandbox_bundle_bytes,
  );
});
