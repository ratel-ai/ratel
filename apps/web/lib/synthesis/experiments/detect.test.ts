import assert from "node:assert/strict";
import { test } from "node:test";
import { detectExperiments, pickBaselineArm } from "./detect";
import type { ExperimentArmAggregate } from "./types";

test("pickBaselineArm prefers control case-insensitively", () => {
  assert.equal(pickBaselineArm(["treatment", "BASELINE", "CONTROL", "a"]), "CONTROL");
});

test("pickBaselineArm prefers baseline when control is absent", () => {
  assert.equal(pickBaselineArm(["treatment", "BASELINE", "a"]), "BASELINE");
});

test("pickBaselineArm prefers a when control and baseline are absent", () => {
  assert.equal(pickBaselineArm(["treatment", "A", "variant"]), "A");
});

test("pickBaselineArm falls back to the lexicographically first arm", () => {
  assert.equal(pickBaselineArm(["variant", "beta", "delta"]), "beta");
});

test("detectExperiments summarizes a split experiment", () => {
  const armAggregates: ExperimentArmAggregate[] = [
    {
      experimentName: "checkout-copy",
      arm: "control",
      traceCount: 6,
      experimentTraceCount: 10,
      firstSeenAt: new Date("2026-07-02T00:00:00Z"),
      lastSeenAt: new Date("2026-07-04T00:00:00Z"),
    },
    {
      experimentName: "checkout-copy",
      arm: "treatment",
      traceCount: 4,
      experimentTraceCount: 10,
      firstSeenAt: new Date("2026-07-01T00:00:00Z"),
      lastSeenAt: new Date("2026-07-05T00:00:00Z"),
    },
  ];

  assert.deepEqual(detectExperiments(armAggregates, []), [
    {
      name: "checkout-copy",
      mode: "split",
      baselineArm: "control",
      traceCount: 10,
      multiArmTraceCount: 0,
      arms: [
        { arm: "control", traceCount: 6, traceShare: 0.6 },
        { arm: "treatment", traceCount: 4, traceShare: 0.4 },
      ],
      firstSeenAt: new Date("2026-07-01T00:00:00Z"),
      lastSeenAt: new Date("2026-07-05T00:00:00Z"),
    },
  ]);
});

test("detectExperiments identifies shadow experiments using unique trace shares", () => {
  const armAggregates: ExperimentArmAggregate[] = [
    {
      experimentName: "search-ranking",
      arm: "control",
      traceCount: 8,
      experimentTraceCount: 8,
      firstSeenAt: new Date("2026-07-01T00:00:00Z"),
      lastSeenAt: new Date("2026-07-02T00:00:00Z"),
    },
    {
      experimentName: "search-ranking",
      arm: "candidate",
      traceCount: 8,
      experimentTraceCount: 8,
      firstSeenAt: new Date("2026-07-01T00:00:00Z"),
      lastSeenAt: new Date("2026-07-02T00:00:00Z"),
    },
  ];

  const [summary] = detectExperiments(armAggregates, [
    { experimentName: "search-ranking", traceCount: 8 },
  ]);

  assert.equal(summary.mode, "shadow");
  assert.equal(summary.multiArmTraceCount, 8);
  assert.equal(summary.traceCount, 8);
  assert.deepEqual(summary.arms, [
    { arm: "candidate", traceCount: 8, traceShare: 1 },
    { arm: "control", traceCount: 8, traceShare: 1 },
  ]);
});

test("detectExperiments identifies partial multi-arm overlap as mixed", () => {
  const armAggregates: ExperimentArmAggregate[] = [
    {
      experimentName: "retrieval-model",
      arm: "control",
      traceCount: 10,
      experimentTraceCount: 10,
      firstSeenAt: new Date("2026-07-01T00:00:00Z"),
      lastSeenAt: new Date("2026-07-02T00:00:00Z"),
    },
    {
      experimentName: "retrieval-model",
      arm: "candidate",
      traceCount: 4,
      experimentTraceCount: 10,
      firstSeenAt: new Date("2026-07-01T00:00:00Z"),
      lastSeenAt: new Date("2026-07-02T00:00:00Z"),
    },
  ];

  const [summary] = detectExperiments(armAggregates, [
    { experimentName: "retrieval-model", traceCount: 4 },
  ]);

  assert.equal(summary.mode, "mixed");
  assert.equal(summary.multiArmTraceCount, 4);
});

test("detectExperiments sorts experiments and arms deterministically", () => {
  const summaries = detectExperiments(
    [
      aggregate("zeta-experiment", "treatment"),
      aggregate("alpha-experiment", "variant"),
      aggregate("zeta-experiment", "control"),
      aggregate("alpha-experiment", "baseline"),
    ],
    [],
  );

  assert.deepEqual(
    summaries.map((summary) => ({
      name: summary.name,
      arms: summary.arms.map((arm) => arm.arm),
    })),
    [
      { name: "alpha-experiment", arms: ["baseline", "variant"] },
      { name: "zeta-experiment", arms: ["control", "treatment"] },
    ],
  );
});

function aggregate(experimentName: string, arm: string): ExperimentArmAggregate {
  return {
    experimentName,
    arm,
    traceCount: 1,
    experimentTraceCount: 2,
    firstSeenAt: new Date("2026-07-01T00:00:00Z"),
    lastSeenAt: new Date("2026-07-02T00:00:00Z"),
  };
}
