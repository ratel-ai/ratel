import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { type DispatchSuccess, dispatchOperation } from "@/lib/mcp/dispatch";
import { buildRegistry } from "@/lib/mcp/registry";
import type { IntentGraphDetail, IntentGraphSummaryRow } from "@/lib/readings/intent-graph/queries";
import { CLOUD_INTENT_GRAPH_KEY } from "@/lib/readings/intent-types/wire";
import { type RankingOperationDeps, rankingOperations } from "./ranking";

/**
 * Adaptive ranking over MCP. These pin that the list names each graph the way
 * the picker does with its serving state, that one graph carries the page's
 * headline, metrics, warnings and setup, that ask group labels (end users'
 * words) are truncated and capped, and that a graph asked for by key that does
 * not exist is not_found rather than silently another graph.
 */
const PROJECT = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-11-05T12:00:00.000Z");

const auth: McpAuthContext = {
  kind: "api-key",
  projectId: PROJECT,
  apiKeyId: "key-1",
  scopes: ["*"],
  organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
};

function summary(
  graphKey: string,
  producer: "cloud" | "runtime",
  liveAt: Date | null,
): IntentGraphSummaryRow {
  return {
    graphKey,
    producer,
    rev: 12,
    model: null,
    clusterCount: 40,
    byteSize: 120_000,
    builtFromTs: NOW,
    receivedAt: NOW,
    updatedAt: new Date("2026-11-05T11:00:00.000Z"),
    toolEdgeCount: 80,
    skillEdgeCount: 0,
    memberCount: 300,
    maturity: 0.456,
    pulledAt: null,
    liveAt,
  };
}

function detail(): IntentGraphDetail {
  const clusters = Array.from({ length: 30 }, (_, index) => ({
    clusterId: `c-${index}`,
    label: index === 0 ? `refund ${"please ".repeat(60)}` : `ask ${index}`,
    labelOverride: null,
    memberCount: 5,
    support: 30 - index,
    seededSupport: 0,
    lastTs: NOW,
    hasCentroid: true,
    terms: ["refund"],
  }));
  return {
    graph: {
      graphKey: CLOUD_INTENT_GRAPH_KEY,
      producer: "cloud",
      rev: 12,
      model: null,
      clusterCount: 30,
      byteSize: 120_000,
      updatedAt: new Date("2026-11-05T11:00:00.000Z"),
      liveAt: new Date("2026-11-01T00:00:00.000Z"),
    },
    clusters,
    edges: [{ clusterId: "c-0", kind: "tool", capabilityId: "gone_tool", weight: 3, surfaced: 2 }],
    missingCapabilities: new Set(["tool:gone_tool"]),
    capabilities: {},
  } as unknown as IntentGraphDetail;
}

function deps(overrides: Partial<RankingOperationDeps> = {}): RankingOperationDeps {
  return {
    listIntentGraphSummaries: async () => [
      summary("my-runtime", "runtime", null),
      summary(CLOUD_INTENT_GRAPH_KEY, "cloud", new Date("2026-11-01T00:00:00.000Z")),
    ],
    listBoostingGraphKeysSince: async () => new Set([CLOUD_INTENT_GRAPH_KEY]),
    listRecentLearningSources: async () => [
      { sourceId: "rt-1", lane: "runtime", searches: 50, invokes: 30, silentCalls: 0, lastAt: NOW },
    ],
    listIntentGraphRuntimeStatus: async () => [],
    getIntentGraphDetail: async () => detail(),
    loadBoostSelections: (async () => ({
      selections: [],
      estimated: false,
      reportedCount: 0,
    })) as unknown as RankingOperationDeps["loadBoostSelections"],
    firstBoostFromGraphAt: async () => null,
    loadOutcomesAroundLive: async () => ({
      before: { turns: 0, recallAt5: null },
      after: { turns: 0, recallAt5: null },
    }),
    now: () => NOW,
    ...overrides,
  };
}

function dispatch(
  operationId: string,
  params: Record<string, unknown>,
  overrides: Partial<RankingOperationDeps> = {},
) {
  return dispatchOperation(operationId, params, {
    registry: buildRegistry(rankingOperations(deps(overrides))),
    auth,
  });
}

function ok(result: Awaited<ReturnType<typeof dispatchOperation>>): DispatchSuccess {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result as DispatchSuccess;
}

test("list_ranking_graphs: picker order, serving state and the merged graph as default", async () => {
  const data = ok(await dispatch("list_ranking_graphs", {})).data as {
    defaultGraphKey: string;
    graphs: Array<{
      graphKey: string;
      label: string;
      served: boolean;
      serving: string;
      learned: number;
    }>;
    setup: Array<{ key: string; state: string }>;
  };
  assert.equal(data.defaultGraphKey, CLOUD_INTENT_GRAPH_KEY);
  assert.deepEqual(
    data.graphs.map((graph) => [graph.graphKey, graph.label, graph.serving]),
    [
      [CLOUD_INTENT_GRAPH_KEY, "All runtimes", "Served"],
      ["my-runtime", "my-runtime (uploaded)", "Served by its runtime"],
    ],
  );
  assert.equal(data.graphs[0]!.learned, 0.46);
  assert.ok(data.setup.length > 0);
});

test("list_ranking_graphs: no graphs yet is the setup steps, not an error", async () => {
  const data = ok(
    await dispatch("list_ranking_graphs", {}, { listIntentGraphSummaries: async () => [] }),
  ).data as {
    count: number;
    defaultGraphKey: string | null;
    setup: unknown[];
  };
  assert.equal(data.count, 0);
  assert.equal(data.defaultGraphKey, null);
  assert.ok(data.setup.length >= 2);
});

test("get_ranking_graph: headline, all five metrics both ways, warnings, facts and capped ask groups", async () => {
  const response = ok(await dispatch("get_ranking_graph", {}));
  const data = response.data as {
    graphKey: string;
    serving: { served: boolean };
    headline: { state: string };
    metrics: Array<{ id: string; without: number | null; withGraph: number | null }>;
    warnings: string[];
    facts: { revision: number; matching: string };
    askGroupCount: number;
    topAskGroups: Array<{ label: string; topTool: string | null; topToolMissing: boolean }>;
  };
  assert.equal(data.graphKey, CLOUD_INTENT_GRAPH_KEY);
  assert.equal(data.serving.served, true);
  assert.equal(data.headline.state, "none");
  assert.deepEqual(
    data.metrics.map((metric) => metric.id),
    ["recall@1", "recall@3", "recall@5", "ndcg@5", "mrr@5"],
  );
  assert.ok(
    data.warnings.some((warning) => warning.includes("gone_tool")),
    "a lifted tool that left the catalog is warned about",
  );
  assert.equal(data.facts.revision, 12);
  assert.equal(data.facts.matching, "Keyword match");
  assert.equal(data.askGroupCount, 30);
  assert.equal(data.topAskGroups.length, 25);
  assert.equal(data.topAskGroups[0]!.topTool, "gone_tool");
  assert.equal(data.topAskGroups[0]!.topToolMissing, true);
  assert.equal(response.truncated, true);
});

test("get_ranking_graph: a graph key that does not exist is not_found", async () => {
  const response = await dispatch("get_ranking_graph", { graphKey: "nope" });
  assert.equal(!response.ok && response.error, "not_found");
});

test("get_ranking_graph: a failed supplementary read degrades, the answer still arrives", async () => {
  const response = await dispatch(
    "get_ranking_graph",
    {},
    {
      listIntentGraphRuntimeStatus: async () => {
        throw new Error("slow");
      },
    },
  );
  assert.equal(response.ok, true);
});
