import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { type DispatchSuccess, dispatchOperation } from "@/lib/mcp/dispatch";
import { buildRegistry } from "@/lib/mcp/registry";
import type { SelectionDetail } from "@/lib/synthesis/experiments/calibration-types";
import type { ExperimentComparison } from "@/lib/synthesis/experiments/types";
import { type ExperimentOperationDeps, experimentOperations } from "./experiments";

/**
 * Experiments over MCP. These pin that an experiment's arms carry their
 * numbers and their change against the baseline with the lifecycle and
 * conversion panels folded in as the page folds them, that a failed panel
 * read costs the panel and not the answer, and that the selection inspector
 * returns both rankings while bounding the raw attributes it reads.
 */
const PROJECT = "11111111-1111-4111-8111-111111111111";

const auth: McpAuthContext = {
  kind: "api-key",
  projectId: PROJECT,
  apiKeyId: "key-1",
  scopes: ["*"],
  organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
};

function metrics(arm: string, latency: number) {
  return {
    arm,
    traceCount: 100,
    errorTraceCount: 4,
    errorRate: 0.04,
    averageLatencyMs: latency,
    p50LatencyMs: latency,
    p95LatencyMs: latency * 2,
    averageInputTokens: 1200.123,
    averageOutputTokens: 300,
    averageCostUsd: 0.0123456789,
    averageSearchCount: 1.5,
    averageSearchHitCount: 4,
  };
}

function comparison(): ExperimentComparison {
  const delta = { absolute: 20, relative: 0.2 };
  return {
    name: "shadow-1",
    mode: "shadow",
    baselineArm: "control",
    arms: [
      { arm: "control", metrics: metrics("control", 100), deltas: null },
      {
        arm: "ratel",
        metrics: metrics("ratel", 120),
        deltas: {
          errorRate: { absolute: 0, relative: 0 },
          averageLatencyMs: delta,
          p95LatencyMs: delta,
          averageInputTokens: delta,
          averageOutputTokens: delta,
          averageCostUsd: delta,
          averageSearchHitCount: null,
        },
      },
    ],
    capabilities: {
      hasRankings: true,
      rows: Array.from({ length: 30 }, (_, index) => ({
        type: "tool" as const,
        id: `tool-${index}`,
        baselineAppearances: 10,
        baselineAverageRank: 2,
        arms: [
          {
            arm: "ratel",
            appearances: 10,
            averageRank: 2 + index,
            rankDelta: index,
            absent: false,
          },
        ],
        maxAbsoluteRankDelta: index,
      })),
      reportedHitMetrics: [],
    },
    issues: [
      {
        kind: "latency_delta",
        severity: "warning",
        arm: "ratel",
        message: "ratel is 20% slower",
        relativeDelta: 0.2,
      },
    ],
  };
}

function deps(overrides: Partial<ExperimentOperationDeps> = {}): ExperimentOperationDeps {
  return {
    getExperimentComparison: async () => comparison(),
    getExperimentLifecycle: async () => ({
      arms: [
        {
          arm: "ratel",
          role: "shadow",
          comparisonCount: 80,
          top1Rate: 0.5,
          exactOrderRate: 0.25,
          averageJaccardAtK: 0.6,
          agreementK: 5,
          skipCount: 2,
          fallbackCount: 1,
          dropCount: 3,
          dropsByReason: { timeout: 3 },
          shadowCoverage: 0.9,
        },
      ],
      diagnostics: { hasLifecycleEvents: true, latestLogAt: new Date("2026-11-04T00:00:00.000Z") },
    }),
    getExperimentConversion: async () => null,
    getSelectionDetail: async () => selection(),
    contentOptIn: async () => true,
    ...overrides,
  };
}

function selection(): SelectionDetail {
  const ids = Array.from({ length: 30 }, (_, index) => `tool-${index}`);
  return {
    selectionId: "sel-1",
    experimentName: "shadow-1",
    traceId: "trace-1",
    traceHasSpans: true,
    records: [
      {
        id: "r1",
        eventName: "ratel.experiment.comparison",
        occurredAt: new Date("2026-11-04T10:00:00.000Z"),
        traceId: "trace-1",
        arm: "ratel",
        role: "shadow",
        experimentAttrs: {
          "ratel.experiment.query": "how do I get a refund for my order",
          "ratel.experiment.served.arm": "control",
          "ratel.experiment.shadow.arm": "ratel",
          "ratel.experiment.served.outcome": "ok",
          "ratel.experiment.shadow.outcome": "ok",
          "ratel.experiment.served.duration_ms": 40,
          "ratel.experiment.shadow.duration_ms": 55,
          "ratel.experiment.agreement.top1": false,
          "ratel.experiment.agreement.k": 5,
          "ratel.debug.blob": "z".repeat(5_000),
        },
      },
      {
        id: "r2",
        eventName: "ratel.experiment.results",
        occurredAt: new Date("2026-11-04T10:00:00.000Z"),
        traceId: "trace-1",
        arm: "control",
        role: "serving",
        experimentAttrs: {
          "ratel.experiment.result_ids": ids,
          "ratel.experiment.result_scores": ids.map(() => 0.123456789),
        },
      },
      {
        id: "r3",
        eventName: "ratel.experiment.results",
        occurredAt: new Date("2026-11-04T10:00:00.000Z"),
        traceId: "trace-1",
        arm: "ratel",
        role: "shadow",
        experimentAttrs: {
          "ratel.experiment.result_ids": ["tool-9", "tool-0"],
          "ratel.experiment.result_scores": [0.9, 0.8],
        },
      },
    ],
  };
}

function dispatch(
  operationId: string,
  params: Record<string, unknown>,
  overrides: Partial<ExperimentOperationDeps> = {},
  caller: McpAuthContext = auth,
) {
  return dispatchOperation(
    operationId,
    { projectId: PROJECT, ...params },
    {
      registry: buildRegistry(experimentOperations(deps(overrides))),
      auth: caller,
    },
  );
}

function ok(result: Awaited<ReturnType<typeof dispatchOperation>>): DispatchSuccess {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result as DispatchSuccess;
}

test("get_experiment: per-arm numbers, the change against the baseline, lifecycle, issues", async () => {
  const response = ok(await dispatch("get_experiment", { experimentName: "shadow-1" }));
  const data = response.data as {
    baselineArm: string;
    arms: Array<{
      arm: string;
      baseline: boolean;
      traces: number;
      errors: number;
      latencyMs: { p95: number };
      averageCostUsd: number;
      vsBaseline: { averageLatencyMs: { relative: number } } | null;
      shadow?: { dropped: number; coverage: number };
    }>;
    issues: Array<{ kind: string }>;
    capabilityRanks: { total: number; rows: Array<{ id: string }> };
    lifecycle: { hasLifecycleEvents: boolean };
    conversion: unknown;
  };
  assert.equal(data.baselineArm, "control");
  const [control, ratel] = data.arms;
  assert.equal(control!.baseline, true);
  assert.equal(control!.vsBaseline, null);
  assert.equal(ratel!.traces, 100);
  assert.equal(ratel!.errors, 4);
  assert.equal(ratel!.latencyMs.p95, 240);
  assert.equal(ratel!.averageCostUsd, 0.012346);
  assert.equal(ratel!.vsBaseline!.averageLatencyMs.relative, 0.2);
  assert.equal(ratel!.shadow!.dropped, 3);
  assert.equal(data.issues[0]!.kind, "latency_delta");
  assert.equal(data.capabilityRanks.total, 30);
  assert.equal(data.capabilityRanks.rows.length, 25);
  assert.equal(data.capabilityRanks.rows[0]!.id, "tool-29", "largest rank change first");
  assert.equal(data.lifecycle.hasLifecycleEvents, true);
  assert.equal(data.conversion, null);
  assert.equal(response.truncated, true);
});

test("get_experiment: a failed lifecycle read costs the panel, not the answer", async () => {
  const response = ok(
    await dispatch(
      "get_experiment",
      { experimentName: "shadow-1" },
      {
        getExperimentLifecycle: async () => {
          throw new Error("timeout");
        },
      },
    ),
  );
  const data = response.data as { lifecycle: unknown; arms: Array<{ shadow?: unknown }> };
  assert.equal(data.lifecycle, null);
  assert.equal(data.arms[1]!.shadow, undefined);
});

test("get_experiment: an experiment with no telemetry in the window is not_found", async () => {
  const response = await dispatch(
    "get_experiment",
    { experimentName: "nope" },
    { getExperimentComparison: async () => null },
  );
  assert.equal(!response.ok && response.error, "not_found");
});

test("get_selection: the query, both rankings with scores, and bounded attributes", async () => {
  const response = ok(await dispatch("get_selection", { selectionId: "sel-1" }));
  const data = response.data as {
    query: string;
    traceId: string;
    traceKept: boolean;
    ranking: {
      k: number;
      sameTop1: boolean;
      served: {
        arm: string;
        durationMs: number;
        results: Array<{ rank: number; id: string; score: number }>;
      };
      shadow: { arm: string; results: Array<{ id: string }> };
    };
    records: Array<{ attributes: Record<string, unknown> }>;
  };
  assert.equal(data.query, "how do I get a refund for my order");
  assert.equal(data.traceId, "trace-1");
  assert.equal(data.traceKept, true);
  assert.equal(data.ranking.k, 5);
  assert.equal(data.ranking.sameTop1, false);
  assert.equal(data.ranking.served.arm, "control");
  assert.equal(data.ranking.served.durationMs, 40);
  assert.equal(data.ranking.served.results.length, 20);
  assert.deepEqual(data.ranking.served.results[0], { rank: 1, id: "tool-0", score: 0.1235 });
  assert.deepEqual(
    data.ranking.shadow.results.map((row) => row.id),
    ["tool-9", "tool-0"],
  );
  const blob = data.records[0]!.attributes["ratel.debug.blob"] as string;
  assert.ok(blob.length <= 201, "raw attributes are truncated");
  const ids = data.records[1]!.attributes["ratel.experiment.result_ids"] as string[];
  assert.equal(ids.length, 10);
  assert.equal(response.truncated, true);
});

test("get_selection: an unknown selection is not_found", async () => {
  const response = await dispatch(
    "get_selection",
    { selectionId: "nope" },
    { getSelectionDetail: async () => null },
  );
  assert.equal(!response.ok && response.error, "not_found");
});

/* A selection's query is an end user's words, on its own and as a record attribute. */

const OAUTH: McpAuthContext = {
  kind: "oauth",
  externalUserId: "user_abc",
  userId: "u-1",
  memberships: [
    {
      organizationId: "org-1",
      role: "member",
      organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
    },
  ],
};

const CONTENT_CASES = [
  { name: "an API key with the content opt-in off", caller: auth, optIn: false, sees: false },
  { name: "an API key with the content opt-in on", caller: auth, optIn: true, sees: true },
  { name: "a signed-in member, whatever the opt-in", caller: OAUTH, optIn: false, sees: true },
] as const;

for (const { name, caller, optIn, sees } of CONTENT_CASES) {
  test(`experiments: captured text for ${name} is ${sees ? "returned" : "withheld"}`, async () => {
    const response = ok(
      await dispatch(
        "get_selection",
        { selectionId: "sel-1" },
        { contentOptIn: async () => optIn },
        caller,
      ),
    );
    const data = response.data as {
      query: string | null;
      ranking: { k: number; served: { arm: string } };
      records: Array<{ attributes: Record<string, unknown> }>;
      contentWithheld?: true;
    };

    assert.equal(data.ranking.k, 5, "both rankings stay");
    assert.equal(data.ranking.served.arm, "control");
    assert.equal(data.records[0]!.attributes["ratel.experiment.served.arm"], "control");
    if (sees) {
      assert.equal(data.query, "how do I get a refund for my order");
      assert.equal(
        data.records[0]!.attributes["ratel.experiment.query"],
        "how do I get a refund for my order",
      );
      assert.equal(data.contentWithheld, undefined);
    } else {
      assert.equal(data.query, null);
      assert.ok(
        !("ratel.experiment.query" in data.records[0]!.attributes),
        "nor as a record attribute",
      );
      assert.ok(!JSON.stringify(data).includes("refund for my order"));
      assert.equal(data.contentWithheld, true);
      assert.match(response.hint ?? "", /signed-in members/);
    }
  });
}
