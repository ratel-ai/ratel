import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { dispatchOperation } from "@/lib/mcp/dispatch";
import { buildRegistry } from "@/lib/mcp/registry";
import type { McpServerDetail, McpServerRow } from "@/lib/views/mcp-servers/queries";
import { type McpServersOperationDeps, mcpServersOperations } from "./mcp-servers";

/**
 * The MCP servers page over MCP (RC-777): the same reads as the page, behind
 * the same flag (`cloud-project-entities`), refused as forbidden when it is off.
 */

const PROJECT = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-11-17T12:00:00.000Z");

const auth: McpAuthContext = {
  kind: "api-key",
  projectId: PROJECT,
  apiKeyId: "key-1",
  scopes: ["*"],
  organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
};

const ROW: McpServerRow = {
  key: "docs-mcp",
  role: "provided",
  displayName: "docs-mcp",
  version: "1.2.0",
  calls: 4,
  errors: 1,
  errorRate: 0.25,
  p95Ms: 370.123,
  sessions: 3,
  firstSeenAt: new Date("2026-11-16T09:00:00.000Z"),
  lastSeenAt: new Date("2026-11-17T09:00:00.000Z"),
};

interface Calls {
  windows: { since: Date; until: Date; environment?: string | null }[];
  refs: unknown[];
  actors: string[];
}

function harness(overrides: Partial<McpServersOperationDeps> = {}) {
  const calls: Calls = { windows: [], refs: [], actors: [] };
  const deps: McpServersOperationDeps = {
    projectEntitiesEnabled: async (_projectId, actor) => {
      calls.actors.push(actor);
      return true;
    },
    listMcpServers: async (_projectId, window) => {
      calls.windows.push(window);
      return { servers: [ROW], environments: ["prod", "staging"] };
    },
    getMcpServer: async (_projectId, ref, window): Promise<McpServerDetail | null> => {
      calls.refs.push(ref);
      calls.windows.push(window);
      if (ref.key !== "docs-mcp") return null;
      return {
        server: ROW,
        roles: ["provided"],
        tools: [{ tool: "search", calls: 4, errors: 1, errorRate: 0.25, p50Ms: 200, p95Ms: 370 }],
        agents: [{ agent: "researcher", calls: 4 }],
      };
    },
    now: () => NOW,
    ...overrides,
  };
  const run = (operationId: string, params: unknown) =>
    dispatchOperation(operationId, params, {
      registry: buildRegistry(mcpServersOperations(deps)),
      auth,
    });
  return { run, calls };
}

function data<T>(result: Awaited<ReturnType<ReturnType<typeof harness>["run"]>>): T {
  assert.ok(result.ok, JSON.stringify(result));
  return result.data as T;
}

test("list_mcp_servers lists the servers with their stats, the environments and each page link", async () => {
  const { run, calls } = harness();
  const out = data<{ servers: Record<string, unknown>[]; environments: string[] }>(
    await run("list_mcp_servers", { environment: "prod" }),
  );
  assert.deepEqual(out.servers, [
    {
      key: "docs-mcp",
      role: "provided",
      name: "docs-mcp",
      version: "1.2.0",
      calls: 4,
      errors: 1,
      errorRate: 0.25,
      p95Ms: 370.12,
      sessions: 3,
      firstSeenAt: "2026-11-16T09:00:00.000Z",
      lastSeenAt: "2026-11-17T09:00:00.000Z",
      href: `/project/${PROJECT}/mcp/docs-mcp?role=provided`,
    },
  ]);
  assert.deepEqual(out.environments, ["prod", "staging"]);
  assert.deepEqual(calls.actors, [`project:${PROJECT}`], "a key is decided as its project");
  // The entities default: the last 30 days.
  assert.deepEqual(calls.windows, [
    { since: new Date("2026-10-18T12:00:00.000Z"), until: NOW, environment: "prod" },
  ]);
});

test("get_mcp_server returns the tools, the calling agents and no protocol or transport when none is kept", async () => {
  const { run, calls } = harness();
  const out = data<Record<string, unknown>>(
    await run("get_mcp_server", { server: "docs-mcp", role: "provided" }),
  );
  assert.deepEqual(calls.refs, [{ key: "docs-mcp", role: "provided" }]);
  assert.deepEqual(out.tools, [
    { tool: "search", calls: 4, errors: 1, errorRate: 0.25, p50Ms: 200, p95Ms: 370 },
  ]);
  assert.deepEqual(out.agents, [{ agent: "researcher", calls: 4 }]);
  assert.equal("protocolVersions" in out, false);
  assert.equal("transports" in out, false);
  assert.equal(out.tracesHref, `/project/${PROJECT}/traces/turns?facetServer=docs-mcp`);
});

test("get_mcp_server of a server with no call in the window is not found", async () => {
  const { run } = harness();
  const result = await run("get_mcp_server", { server: "nobody" });
  assert.equal(result.ok === false && result.error, "not_found");
});

test("both tools refuse as forbidden with cloud-project-entities off, and read nothing", async () => {
  const { run, calls } = harness({ projectEntitiesEnabled: async () => false });
  for (const [id, params] of [
    ["list_mcp_servers", {}],
    ["get_mcp_server", { server: "docs-mcp" }],
  ] as const) {
    const result = await run(id, params);
    assert.equal(result.ok === false && result.error, "forbidden", id);
    assert.equal(result.ok === false && result.reason, "project_entities_off", id);
  }
  assert.deepEqual(calls.windows, []);
});
