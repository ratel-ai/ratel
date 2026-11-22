import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { dispatchOperation } from "@/lib/mcp/dispatch";
import { buildRegistry } from "@/lib/mcp/registry";
import type { AgentDetail, AgentRow, AgentWindow } from "@/lib/views/agents/domain/types";
import { type AgentsOperationDeps, agentsOperations } from "./agents";

/**
 * The Agents page over MCP (RC-775): the same reads as the page.
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

const ROW: AgentRow = {
  key: "researcher",
  displayName: "researcher",
  hidden: false,
  mergedKeys: [],
  calls: 4,
  errors: 1,
  errorRate: 0.25,
  costUsd: 0.0123,
  p95Ms: 870.123,
  firstSeenAt: new Date("2026-11-16T09:00:00.000Z"),
  lastSeenAt: new Date("2026-11-17T09:00:00.000Z"),
  detection: null,
};

function harness(overrides: Partial<AgentsOperationDeps> = {}) {
  const calls = { windows: [] as AgentWindow[], keys: [] as string[] };
  const deps: AgentsOperationDeps = {
    listAgents: async (_projectId, window) => {
      calls.windows.push(window);
      return { agents: [ROW], environments: ["prod", "staging"] };
    },
    listHandoffs: async (_projectId, window) => {
      calls.windows.push(window);
      return [
        {
          from: "supervisor",
          to: "researcher",
          fromName: "supervisor",
          toName: "researcher",
          count: 4,
        },
      ];
    },
    getAgent: async (_projectId, key, window): Promise<AgentDetail | null> => {
      calls.keys.push(key);
      calls.windows.push(window);
      if (key !== "researcher") return null;
      return {
        agent: ROW,
        tools: [{ tool: "search", calls: 3, errors: 1, errorRate: 1 / 3, p95Ms: 49 }],
        mcpServers: [{ server: "docs-mcp", calls: 1, errors: 0 }],
        callers: [
          {
            from: "supervisor",
            to: "researcher",
            fromName: "supervisor",
            toName: "researcher",
            count: 4,
          },
        ],
        callees: [],
      };
    },
    now: () => NOW,
    ...overrides,
  };
  const run = (operationId: string, params: unknown) =>
    dispatchOperation(operationId, params, {
      registry: buildRegistry(agentsOperations(deps)),
      auth,
    });
  return { run, calls };
}

function data<T>(result: Awaited<ReturnType<ReturnType<typeof harness>["run"]>>): T {
  assert.ok(result.ok, JSON.stringify(result));
  return result.data as T;
}

test("list_agents lists the agents with their stats, the handoffs, the environments and each page link", async () => {
  const { run, calls } = harness();
  const out = data<Record<string, unknown>>(await run("list_agents", { environment: "prod" }));
  assert.deepEqual(out.agents, [
    {
      key: "researcher",
      name: "researcher",
      runs: 4,
      errors: 1,
      errorRate: 0.25,
      costUsd: 0.0123,
      p95Ms: 870.12,
      firstSeenAt: "2026-11-16T09:00:00.000Z",
      lastSeenAt: "2026-11-17T09:00:00.000Z",
      href: `/project/${PROJECT}/agents/researcher`,
    },
  ]);
  assert.deepEqual(out.handoffs, [
    {
      from: "supervisor",
      to: "researcher",
      fromName: "supervisor",
      toName: "researcher",
      count: 4,
    },
  ]);
  assert.deepEqual(out.environments, ["prod", "staging"]);
  const window = { since: new Date("2026-10-18T12:00:00.000Z"), until: NOW, environment: "prod" };
  assert.deepEqual(calls.windows, [window, window], "the entities default: the last 30 days");
});

test("get_agent returns the tools, the MCP servers, the handoffs and the filtered Traces link", async () => {
  const { run, calls } = harness();
  const out = data<Record<string, unknown>>(await run("get_agent", { agent: "researcher" }));
  assert.deepEqual(calls.keys, ["researcher"]);
  assert.deepEqual(out.tools, [
    { tool: "search", calls: 3, errors: 1, errorRate: 0.3333, p95Ms: 49 },
  ]);
  assert.deepEqual(out.mcpServers, [{ server: "docs-mcp", calls: 1, errors: 0 }]);
  assert.deepEqual(out.callers, [
    {
      from: "supervisor",
      to: "researcher",
      fromName: "supervisor",
      toName: "researcher",
      count: 4,
    },
  ]);
  assert.equal(out.tracesHref, `/project/${PROJECT}/traces/turns?facetAgent=researcher`);
});

test("get_agent of an agent with no run in the window is not found", async () => {
  const { run } = harness();
  const result = await run("get_agent", { agent: "nobody" });
  assert.equal(result.ok === false && result.error, "not_found");
});
