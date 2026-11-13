import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { mcpLoopEnabled } from "@/lib/mcp/loop-flag";

const auth: McpAuthContext = {
  kind: "api-key",
  projectId: "11111111-1111-4111-8111-111111111111",
  apiKeyId: "key-1",
  organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
};

test("the improvement-loop tools are off by default", async () => {
  assert.equal(await mcpLoopEnabled(auth, {}), false);
  assert.equal(await mcpLoopEnabled(auth, { FF_MCP_LOOP: "0" }), false);
});

test("FF_MCP_LOOP lists them for every caller of the deployment", async () => {
  assert.equal(await mcpLoopEnabled(auth, { FF_MCP_LOOP: "1" }), true);
  assert.equal(await mcpLoopEnabled(auth, { FF_MCP_LOOP: "true" }), true);
});
