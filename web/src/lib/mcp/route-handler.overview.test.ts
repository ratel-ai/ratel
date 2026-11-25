import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMcpAppCatalog } from "@/lib/mcp/apps/catalog";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { createMcpRouteHandler } from "@/lib/mcp/route-handler";
import { createTokenBucketRateLimiter } from "@/lib/platform/rate-limit";

/** What a client is told exists, with `focusedConsole` on and off for it. */

const auth: McpAuthContext = {
  kind: "api-key",
  projectId: "11111111-1111-4111-8111-111111111111",
  apiKeyId: "k1",
  scopes: ["*"],
  organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
};
const HTML = "<!doctype html><html><head></head><body></body></html>";
const catalog = buildMcpAppCatalog(
  [
    { view: "overview", html: HTML, bindings: [{ tool: "get_overview" }] },
    { view: "health", html: HTML, bindings: [{ tool: "get_agent_health" }] },
  ],
  new Set(["get_overview", "get_agent_health"]),
);

async function call(on: boolean, method: string, params: unknown = {}) {
  const limiter = () => createTokenBucketRateLimiter({ limitPerMinute: 600, burst: 900 });
  const handler = createMcpRouteHandler({
    authenticate: async () => ({ ok: true, auth }),
    credentialLimiter: limiter(),
    perKeyLimiter: limiter(),
    globalLimiter: limiter(),
    trackServerEvent: (async () => undefined) as never,
    launchAccess: async () => true,
    mcpApps: async () => true,
    focusedConsole: async () => on,
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

test("on, the two tools are listed and get_overview has its view", async () => {
  const { tools } = (await call(true, "tools/list")).result;
  const named = (name: string) => tools.find((tool) => tool.name === name);
  assert.deepEqual(named("get_overview")?._meta?.ui, { resourceUri: "ui://ratel/overview" });
  assert.equal(named("get_overview")?.annotations.readOnlyHint, true);
  assert.equal(named("change_overview_layout")?.annotations.readOnlyHint, false);
  const { resources } = (await call(true, "resources/list")).result;
  assert.ok(resources.some(({ uri }) => uri === "ui://ratel/overview"));
});

test("off, neither tool nor the view exists", async () => {
  const { tools } = (await call(false, "tools/list")).result;
  assert.ok(
    !tools.some(({ name }) => name === "get_overview" || name === "change_overview_layout"),
  );
  const { resources } = (await call(false, "resources/list")).result;
  assert.deepEqual(
    resources.map(({ uri }) => uri),
    ["ui://ratel/health"],
  );
  for (const name of ["get_overview", "change_overview_layout"]) {
    const reply = await call(false, "tools/call", { name, arguments: { change: "reset" } });
    assert.ok(reply.error || reply.result.isError, name);
  }
});
