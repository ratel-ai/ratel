import assert from "node:assert/strict";
import { test } from "node:test";
import { TOOL_CATALOG_SNIPPET } from "@/lib/console/catalog/sync-snippet";
import { apiUrl } from "@/lib/platform/app-config";

test("the catalog snippet attaches the runtime to this deployment, then registers a tool", () => {
  const lines = TOOL_CATALOG_SNIPPET.split("\n");
  const attach = lines.findIndex((line) => line.startsWith("ratelCloud.attach(runtime,"));
  const register = lines.findIndex((line) => line.startsWith("await runtime.tools.register("));
  assert.ok(lines.includes('import * as ratelCloud from "@ratel-ai/cloud-sdk/runtime";'));
  assert.equal(
    lines[attach],
    `ratelCloud.attach(runtime, { baseUrl: "${apiUrl()}", useCloudDefinitions: true }); // Reads RATEL_API_KEY.`,
  );
  assert.ok(attach > 0 && attach < register, "attached before the first registration");
});

test("the address is the API root the SDK expects, with the /api/v1 prefix", () => {
  assert.match(TOOL_CATALOG_SNIPPET, /baseUrl: "https?:\/\/[^"]+\/api\/v1"/);
});
