import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { createMcpRouteHandler } from "@/lib/mcp/route-handler";
import { createTokenBucketRateLimiter } from "@/lib/platform/rate-limit";

/** What a client is told exists, with the one flag `evals` on and off for it (decision `one-flag`). */

const auth: McpAuthContext = {
  kind: "api-key",
  projectId: "11111111-1111-4111-8111-111111111111",
  apiKeyId: "k1",
  scopes: ["*"],
  organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
};

test("off, the server lists no sandbox_* and no evals_* tool", async () => {
  const names = await listedTools(false);
  assert.ok(names.length > 0);
  assert.deepEqual(names.filter(isGated), []);
});

test("on, the one flag lists the sandbox tools and the eval tools together", async () => {
  const names = await listedTools(true);
  for (const name of ["sandbox_list", "sandbox_get_version", "sandbox_run", "sandbox_get_run"])
    assert.ok(names.includes(name), name);
  assert.ok(names.some((name) => name.startsWith("evals_")));
});

async function listedTools(evals: boolean): Promise<string[]> {
  const limiter = () => createTokenBucketRateLimiter({ limitPerMinute: 600, burst: 900 });
  const handler = createMcpRouteHandler({
    authenticate: async () => ({ ok: true, auth }),
    credentialLimiter: limiter(),
    perKeyLimiter: limiter(),
    globalLimiter: limiter(),
    trackServerEvent: (async () => undefined) as never,
    launchAccess: async () => true,
    mcpApps: async () => false,
    focusedConsole: async () => false,
    evals: async () => evals,
  });
  const response = await handler(
    new Request("https://cloud.ratel.sh/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer rtl_test" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }),
  );
  const body = (await response.json()) as { result: { tools: { name: string }[] } };
  return body.result.tools.map((tool) => tool.name);
}

function isGated(name: string): boolean {
  return name.startsWith("sandbox_") || name.startsWith("evals_");
}
