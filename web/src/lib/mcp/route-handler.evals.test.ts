import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { createMcpRouteHandler } from "@/lib/mcp/route-handler";
import { createTokenBucketRateLimiter } from "@/lib/platform/rate-limit";

/** With the `evals` flag removed, every client is told the sandbox and eval tools exist. */

const auth: McpAuthContext = {
  kind: "api-key",
  projectId: "11111111-1111-4111-8111-111111111111",
  apiKeyId: "k1",
  scopes: ["*"],
  organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
};

test("the server lists the sandbox tools and the eval tools with no flag", async () => {
  const names = await listedTools();
  for (const name of ["sandbox_list", "sandbox_get_version", "sandbox_run", "sandbox_get_run"])
    assert.ok(names.includes(name), name);
  assert.ok(names.some((name) => name.startsWith("evals_")));
});

async function listedTools(): Promise<string[]> {
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
