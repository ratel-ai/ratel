import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExperimentQueries } from "./service";
import { createExperimentService } from "./service";

const SINCE = new Date("2026-07-01T00:00:00.000Z");
const UNTIL = new Date("2026-08-01T00:00:00.000Z");

test("listExperiments returns detected experiment summaries", async () => {
  const service = createExperimentService(
    queries({
      listExperimentDetectionAggregates: async () => ({
        armAggregates: [
          {
            experimentName: "checkout",
            arm: "control",
            traceCount: 3,
            experimentTraceCount: 5,
            firstSeenAt: new Date("2026-07-02T00:00:00.000Z"),
            lastSeenAt: new Date("2026-07-05T00:00:00.000Z"),
          },
          {
            experimentName: "checkout",
            arm: "variant",
            traceCount: 2,
            experimentTraceCount: 5,
            firstSeenAt: new Date("2026-07-03T00:00:00.000Z"),
            lastSeenAt: new Date("2026-07-06T00:00:00.000Z"),
          },
        ],
        multiArmCounts: [],
      }),
    }),
  );

  assert.deepEqual(await service.listExperiments("project-1", { since: SINCE, until: UNTIL }), [
    {
      name: "checkout",
      mode: "split",
      baselineArm: "control",
      traceCount: 5,
      multiArmTraceCount: 0,
      arms: [
        { arm: "control", traceCount: 3, traceShare: 0.6 },
        { arm: "variant", traceCount: 2, traceShare: 0.4 },
      ],
      firstSeenAt: new Date("2026-07-02T00:00:00.000Z"),
      lastSeenAt: new Date("2026-07-06T00:00:00.000Z"),
    },
  ]);
});

test("getExperimentComparison combines metrics, capability fallback, and issues", async () => {
  const armAggregates = [
    {
      experimentName: "checkout",
      arm: "control",
      traceCount: 20,
      experimentTraceCount: 40,
      firstSeenAt: SINCE,
      lastSeenAt: UNTIL,
    },
    {
      experimentName: "checkout",
      arm: "variant",
      traceCount: 20,
      experimentTraceCount: 40,
      firstSeenAt: SINCE,
      lastSeenAt: UNTIL,
    },
  ];
  const service = createExperimentService(
    queries({
      listExperimentDetectionAggregates: async () => ({
        armAggregates,
        multiArmCounts: [],
      }),
      getArmMetricAggregates: async () => [
        metric("control", { errorTraceCount: 1, p95LatencyMs: 120 }),
        metric("variant", { errorTraceCount: 3, p95LatencyMs: 150 }),
      ],
      listArmSearchSpans: async () => [
        {
          arm: "control",
          traceId: "trace-control",
          spanId: "span-control",
          reportedHitCount: 8,
          hits: [],
        },
        {
          arm: "variant",
          traceId: "trace-variant",
          spanId: "span-variant",
          reportedHitCount: 5,
          hits: [],
        },
      ],
    }),
  );

  const comparison = await service.getExperimentComparison("project-1", "checkout", {
    since: SINCE,
    until: UNTIL,
  });

  assert.equal(comparison?.name, "checkout");
  assert.equal(comparison?.baselineArm, "control");
  assert.deepEqual(
    comparison?.arms.map(({ arm, metrics, deltas }) => ({
      arm,
      errorRate: metrics.errorRate,
      p95LatencyDelta: deltas?.p95LatencyMs.relative ?? null,
    })),
    [
      { arm: "control", errorRate: 0.05, p95LatencyDelta: null },
      { arm: "variant", errorRate: 0.15, p95LatencyDelta: 0.25 },
    ],
  );
  assert.deepEqual(comparison?.capabilities, {
    hasRankings: false,
    rows: [],
    reportedHitMetrics: [
      {
        arm: "control",
        total: 8,
        searchSpanCount: 1,
        averagePerSearch: 8,
      },
      {
        arm: "variant",
        total: 5,
        searchSpanCount: 1,
        averagePerSearch: 5,
      },
    ],
  });
  assert.deepEqual(
    comparison?.issues.map(({ kind, severity, arm }) => ({
      kind,
      severity,
      arm,
    })),
    [
      { kind: "error_rate_delta", severity: "error", arm: "variant" },
      { kind: "latency_delta", severity: "warning", arm: "variant" },
    ],
  );
});

test("getExperimentComparison aligns metric and capability arm order", async () => {
  const service = createExperimentService(
    queries({
      listExperimentDetectionAggregates: async () => ({
        armAggregates: [
          {
            experimentName: "ranking",
            arm: "candidate",
            traceCount: 20,
            experimentTraceCount: 40,
            firstSeenAt: SINCE,
            lastSeenAt: UNTIL,
          },
          {
            experimentName: "ranking",
            arm: "control",
            traceCount: 20,
            experimentTraceCount: 40,
            firstSeenAt: SINCE,
            lastSeenAt: UNTIL,
          },
        ],
        multiArmCounts: [],
      }),
      getArmMetricAggregates: async () => [metric("candidate"), metric("control")],
      listArmSearchSpans: async () => [
        {
          arm: "candidate",
          traceId: "trace-candidate",
          spanId: "span-candidate",
          reportedHitCount: 1,
          hits: [{ type: "tool", id: "deploy", rank: 1, score: null }],
        },
        {
          arm: "control",
          traceId: "trace-control",
          spanId: "span-control",
          reportedHitCount: 1,
          hits: [{ type: "tool", id: "deploy", rank: 0, score: null }],
        },
      ],
    }),
  );

  const comparison = await service.getExperimentComparison("project-1", "ranking", {
    since: SINCE,
    until: UNTIL,
  });

  assert.deepEqual(
    {
      metrics: comparison?.arms.map(({ arm }) => arm),
      capabilityRows: comparison?.capabilities.rows[0]?.arms.map(({ arm }) => arm),
      reportedHits: comparison?.capabilities.reportedHitMetrics.map(({ arm }) => arm),
    },
    {
      metrics: ["control", "candidate"],
      capabilityRows: ["control", "candidate"],
      reportedHits: ["control", "candidate"],
    },
  );
});

test("getExperimentComparison includes lifecycle metrics and diagnostics when requested", async () => {
  const lifecycle = {
    arm: "candidate",
    role: "shadow" as const,
    comparisonCount: 4,
    top1Rate: 0.75,
    exactOrderRate: 0.5,
    averageJaccardAtK: 0.8,
    agreementK: 5,
    skipCount: 1,
    fallbackCount: 2,
    dropCount: 1,
    dropsByReason: { timeout: 1 },
    shadowCoverage: 2 / 3,
  };
  const diagnostics = {
    hasLifecycleEvents: true,
    latestLogAt: new Date("2026-07-20T12:00:00.000Z"),
  };
  const conversion = {
    arms: [
      {
        arm: "control",
        outcomeCount: 2,
        outcomesByLabel: { accepted: 2 },
        unlabeledOutcomeCount: 0,
        averageOutcomeScore: 0.75,
        invocationCount: 3,
        servedInvocationCount: 2,
        notServedInvocationCount: 1,
        invocationRankHistogram: { "-1": 1, "0": 2 },
        averageInvocationAgeMs: 400,
      },
    ],
    invocationCount: 4,
    attributedInvocationCount: 3,
    unattributedInvocationCount: 1,
    invocationAttributionRate: 0.75,
    unresolvedOutcomeCount: 2,
  };
  const service = createExperimentService(
    queries({
      listExperimentDetectionAggregates: async () => ({
        armAggregates: [
          {
            experimentName: "ranking",
            arm: "control",
            traceCount: 20,
            experimentTraceCount: 40,
            firstSeenAt: SINCE,
            lastSeenAt: UNTIL,
          },
          {
            experimentName: "ranking",
            arm: "candidate",
            traceCount: 20,
            experimentTraceCount: 40,
            firstSeenAt: SINCE,
            lastSeenAt: UNTIL,
          },
        ],
        multiArmCounts: [],
      }),
      getArmMetricAggregates: async () => [metric("control"), metric("candidate")],
      listExperimentLifecycleArmMetrics: async () => [lifecycle],
      getExperimentLifecycleDiagnostics: async () => diagnostics,
      getExperimentConversionMetrics: async () => conversion,
    }),
  );

  const comparison = await service.getExperimentComparison(
    "project-1",
    "ranking",
    { since: SINCE, until: UNTIL },
    { includeLifecycle: true },
  );

  assert.deepEqual(
    comparison?.arms.map(({ arm, lifecycle, conversion }) => ({
      arm,
      lifecycle,
      conversion,
    })),
    [
      { arm: "control", lifecycle: null, conversion: conversion.arms[0] },
      { arm: "candidate", lifecycle, conversion: null },
    ],
  );
  assert.deepEqual(comparison?.lifecycleDiagnostics, diagnostics);
  assert.deepEqual(comparison?.conversionSummary, {
    invocationCount: 4,
    attributedInvocationCount: 3,
    unattributedInvocationCount: 1,
    invocationAttributionRate: 0.75,
    unresolvedOutcomeCount: 2,
  });
});

test("getExperimentComparison does not query or expose lifecycle data by default", async () => {
  let lifecycleQueryCount = 0;
  const service = createExperimentService(
    queries({
      listExperimentDetectionAggregates: async () => ({
        armAggregates: [
          {
            experimentName: "ranking",
            arm: "control",
            traceCount: 20,
            experimentTraceCount: 20,
            firstSeenAt: SINCE,
            lastSeenAt: UNTIL,
          },
        ],
        multiArmCounts: [],
      }),
      getArmMetricAggregates: async () => [metric("control")],
      listExperimentLifecycleArmMetrics: async () => {
        lifecycleQueryCount += 1;
        return [];
      },
      getExperimentLifecycleDiagnostics: async () => {
        lifecycleQueryCount += 1;
        return { hasLifecycleEvents: false, latestLogAt: null };
      },
      getExperimentConversionMetrics: async () => {
        lifecycleQueryCount += 1;
        return {
          arms: [],
          invocationCount: 0,
          attributedInvocationCount: 0,
          unattributedInvocationCount: 0,
          invocationAttributionRate: null,
          unresolvedOutcomeCount: 0,
        };
      },
    }),
  );

  const comparison = await service.getExperimentComparison("project-1", "ranking", {
    since: SINCE,
    until: UNTIL,
  });

  assert.equal(lifecycleQueryCount, 0);
  assert.equal(comparison?.arms[0]?.lifecycle, undefined);
  assert.equal(comparison == null || "lifecycleDiagnostics" in comparison, false);
  assert.equal(comparison == null || "conversionSummary" in comparison, false);
});

test("supplementary experiment loaders skip the primary comparison queries", async () => {
  let primaryQueryCount = 0;
  const diagnostics = { hasLifecycleEvents: false, latestLogAt: null };
  const conversion = {
    arms: [],
    invocationCount: 0,
    attributedInvocationCount: 0,
    unattributedInvocationCount: 0,
    invocationAttributionRate: null,
    unresolvedOutcomeCount: 0,
  };
  const service = createExperimentService(
    queries({
      listExperimentDetectionAggregates: async () => {
        primaryQueryCount += 1;
        return { armAggregates: [], multiArmCounts: [] };
      },
      getArmMetricAggregates: async () => {
        primaryQueryCount += 1;
        return [];
      },
      listArmSearchSpans: async () => {
        primaryQueryCount += 1;
        return [];
      },
      listExperimentLifecycleArmMetrics: async () => [],
      getExperimentLifecycleDiagnostics: async () => diagnostics,
      getExperimentConversionMetrics: async () => conversion,
    }),
  );

  const [lifecycleResult, conversionResult] = await Promise.all([
    service.getExperimentLifecycle("project-1", "ranking", {
      since: SINCE,
      until: UNTIL,
    }),
    service.getExperimentConversion("project-1", "ranking", {
      since: SINCE,
      until: UNTIL,
    }),
  ]);

  assert.deepEqual(lifecycleResult, { arms: [], diagnostics });
  assert.deepEqual(conversionResult, conversion);
  assert.equal(primaryQueryCount, 0);
});

function queries(overrides: Partial<ExperimentQueries>): ExperimentQueries {
  return {
    listExperimentDetectionAggregates: async () => ({
      armAggregates: [],
      multiArmCounts: [],
    }),
    getArmMetricAggregates: async () => [],
    listArmSearchSpans: async () => [],
    listExperimentLifecycleArmMetrics: async () => [],
    getExperimentLifecycleDiagnostics: async () => ({
      hasLifecycleEvents: false,
      latestLogAt: null,
    }),
    getExperimentConversionMetrics: async () => ({
      arms: [],
      invocationCount: 0,
      attributedInvocationCount: 0,
      unattributedInvocationCount: 0,
      invocationAttributionRate: null,
      unresolvedOutcomeCount: 0,
    }),
    ...overrides,
  };
}

function metric(
  arm: string,
  overrides: Partial<{
    errorTraceCount: number;
    p95LatencyMs: number;
  }> = {},
) {
  return {
    arm,
    traceCount: 20,
    errorTraceCount: overrides.errorTraceCount ?? 0,
    averageLatencyMs: 100,
    p50LatencyMs: 90,
    p95LatencyMs: overrides.p95LatencyMs ?? 120,
    averageInputTokens: 1_000,
    averageOutputTokens: 500,
    averageCostUsd: 1,
    averageSearchCount: 2,
    averageSearchHitCount: 10,
  };
}
