import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMcpAppCatalog } from "@/lib/mcp/apps/catalog";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { createMcpRouteHandler } from "@/lib/mcp/route-handler";
import { createTokenBucketRateLimiter } from "@/lib/platform/rate-limit";

/** What a client is told exists of RQL. */

const auth: McpAuthContext = {
  kind: "api-key",
  projectId: "11111111-1111-4111-8111-111111111111",
  apiKeyId: "k1",
  scopes: ["*"],
  organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
};
const TOOLS = ["describe_rql_schema", "run_rql", "list_dashboard_templates"];
const HTML = "<!doctype html><html><head></head><body></body></html>";
const catalog = buildMcpAppCatalog(
  [
    { view: "table", html: HTML, bindings: [{ tool: "run_rql" }] },
    { view: "health", html: HTML, bindings: [{ tool: "get_agent_health" }] },
  ],
  new Set(["run_rql", "get_agent_health"]),
);

async function call(method: string, params: unknown = {}) {
  const limiter = () => createTokenBucketRateLimiter({ limitPerMinute: 600, burst: 900 });
  const handler = createMcpRouteHandler({
    authenticate: async () => ({ ok: true, auth }),
    credentialLimiter: limiter(),
    perKeyLimiter: limiter(),
    globalLimiter: limiter(),
    trackServerEvent: (async () => undefined) as never,
    launchAccess: async () => true,
    mcpApps: async () => true,
    focusedConsole: async () => false,
    appCatalog: () => catalog,
  });
  const response = await handler(
    new Request("https://cloud.ratel.sh/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer rtl_test" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  return (await response.json()) as {
    error?: unknown;
    result: {
      isError?: boolean;
      tools: { name: string; annotations: { readOnlyHint?: boolean }; _meta?: { ui?: unknown } }[];
      resources: { uri: string }[];
    };
  };
}

test("the tools are listed as reads, and run_rql has the table view", async () => {
  const { tools } = (await call("tools/list")).result;
  const named = (name: string) => tools.find((tool) => tool.name === name);
  for (const tool of TOOLS) assert.equal(named(tool)?.annotations.readOnlyHint, true, tool);
  assert.deepEqual(named("run_rql")?._meta?.ui, { resourceUri: "ui://ratel/table" });
  const { resources } = (await call("resources/list")).result;
  assert.ok(resources.some(({ uri }) => uri === "ui://ratel/table"));
});
