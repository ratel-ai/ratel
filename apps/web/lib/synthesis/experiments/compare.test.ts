import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attachExperimentConversionMetrics,
  attachExperimentLifecycleMetrics,
  compareArmMetrics,
} from "./compare";
import type {
  ArmMetricAggregate,
  ExperimentArmConversionMetrics,
  ExperimentLifecycleArmMetrics,
} from "./types";

test("compareArmMetrics reports literal deltas from the baseline", () => {
  const baseline = aggregate("control", {
    traceCount: 8,
    errorTraceCount: 2,
    averageLatencyMs: 100,
    p50LatencyMs: 50,
    p95LatencyMs: 200,
    averageInputTokens: 1_000,
    averageOutputTokens: 400,
    averageCostUsd: 2,
    averageSearchCount: 5,
    averageSearchHitCount: 20,
  });
  const treatment = aggregate("treatment", {
    traceCount: 8,
    errorTraceCount: 4,
    averageLatencyMs: 125,
    p50LatencyMs: 75,
    p95LatencyMs: 300,
    averageInputTokens: 750,
    averageOutputTokens: 600,
    averageCostUsd: 3,
    averageSearchCount: 4,
    averageSearchHitCount: 10,
  });

  assert.deepEqual(compareArmMetrics("control", [baseline, treatment]), [
    {
      arm: "control",
      metrics: { ...baseline, errorRate: 0.25 },
      deltas: null,
    },
    {
      arm: "treatment",
      metrics: { ...treatment, errorRate: 0.5 },
      deltas: {
        errorRate: { absolute: 0.25, relative: 1 },
        averageLatencyMs: { absolute: 25, relative: 0.25 },
        p95LatencyMs: { absolute: 100, relative: 0.5 },
        averageInputTokens: { absolute: -250, relative: -0.25 },
        averageOutputTokens: { absolute: 200, relative: 0.5 },
        averageCostUsd: { absolute: 1, relative: 0.5 },
        averageSearchHitCount: { absolute: -10, relative: -0.5 },
      },
    },
  ]);
});

test("compareArmMetrics puts the baseline first and sorts other arms", () => {
  const shared = {
    traceCount: 1,
    errorTraceCount: 0,
    averageLatencyMs: 100,
    p50LatencyMs: 100,
    p95LatencyMs: 100,
    averageInputTokens: 10,
    averageOutputTokens: 5,
    averageCostUsd: 0.01,
    averageSearchCount: 1,
    averageSearchHitCount: 2,
  };

  assert.deepEqual(
    compareArmMetrics("control", [
      aggregate("zeta", shared),
      aggregate("control", shared),
      aggregate("alpha", shared),
    ]).map(({ arm }) => arm),
    ["control", "alpha", "zeta"],
  );
});

test("compareArmMetrics leaves search-hit deltas unknown when counts are unknown", () => {
  const shared = {
    traceCount: 1,
    errorTraceCount: 0,
    averageLatencyMs: 100,
    p50LatencyMs: 100,
    p95LatencyMs: 100,
    averageInputTokens: 10,
    averageOutputTokens: 5,
    averageCostUsd: 0.01,
    averageSearchCount: 1,
  };

  const compared = compareArmMetrics("control", [
    aggregate("control", { ...shared, averageSearchHitCount: 2 }),
    aggregate("variant", { ...shared, averageSearchHitCount: null }),
  ]);

  assert.equal(compared[1]?.metrics.averageSearchHitCount, null);
  assert.equal(compared[1]?.deltas?.averageSearchHitCount, null);
});

test("attachExperimentLifecycleMetrics aligns shadow metrics by arm and preserves unknowns", () => {
  const shared = {
    traceCount: 1,
    errorTraceCount: 0,
    averageLatencyMs: 100,
    p50LatencyMs: 100,
    p95LatencyMs: 100,
    averageInputTokens: 10,
    averageOutputTokens: 5,
    averageCostUsd: 0.01,
    averageSearchCount: 1,
    averageSearchHitCount: 2,
  };
  const compared = compareArmMetrics("control", [
    aggregate("control", shared),
    aggregate("candidate", shared),
    aggregate("unreported", shared),
  ]);
  const candidate = lifecycleMetrics("candidate");

  assert.deepEqual(
    attachExperimentLifecycleMetrics(compared, [candidate]).map(({ arm, lifecycle }) => ({
      arm,
      lifecycle,
    })),
    [
      { arm: "control", lifecycle: null },
      { arm: "candidate", lifecycle: candidate },
      { arm: "unreported", lifecycle: null },
    ],
  );
});

test("attachExperimentConversionMetrics preserves nullable arms and no-outcome metrics", () => {
  const shared = {
    traceCount: 1,
    errorTraceCount: 0,
    averageLatencyMs: 100,
    p50LatencyMs: 100,
    p95LatencyMs: 100,
    averageInputTokens: 10,
    averageOutputTokens: 5,
    averageCostUsd: 0.01,
    averageSearchCount: 1,
    averageSearchHitCount: 2,
  };
  const compared = compareArmMetrics("control", [
    aggregate("control", shared),
    aggregate("candidate", shared),
    aggregate("unreported", shared),
  ]);
  const candidate = conversionMetrics("candidate");

  assert.deepEqual(
    attachExperimentConversionMetrics(compared, [candidate]).map(({ arm, conversion }) => ({
      arm,
      conversion,
    })),
    [
      { arm: "control", conversion: null },
      { arm: "candidate", conversion: candidate },
      { arm: "unreported", conversion: null },
    ],
  );
  assert.equal(candidate.outcomeCount, 0);
  assert.equal(candidate.averageOutcomeScore, null);
});

function aggregate(arm: string, values: Omit<ArmMetricAggregate, "arm">): ArmMetricAggregate {
  return { arm, ...values };
}

function lifecycleMetrics(arm: string): ExperimentLifecycleArmMetrics {
  return {
    arm,
    role: "shadow",
    comparisonCount: 2,
    top1Rate: 0.5,
    exactOrderRate: 1,
    averageJaccardAtK: 0.75,
    agreementK: 5,
    skipCount: 1,
    fallbackCount: 0,
    dropCount: 1,
    dropsByReason: { timeout: 1 },
    shadowCoverage: 0.5,
  };
}

function conversionMetrics(arm: string): ExperimentArmConversionMetrics {
  return {
    arm,
    outcomeCount: 0,
    outcomesByLabel: {},
    unlabeledOutcomeCount: 0,
    averageOutcomeScore: null,
    invocationCount: 2,
    servedInvocationCount: 1,
    notServedInvocationCount: 1,
    invocationRankHistogram: { "-1": 1, "0": 1 },
    averageInvocationAgeMs: 250,
  };
}
