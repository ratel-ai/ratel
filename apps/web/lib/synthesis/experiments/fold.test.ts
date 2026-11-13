import assert from "node:assert/strict";
import { test } from "node:test";
import { type ExperimentTraceArm, foldExperimentTraceArms } from "./fold";

test("foldExperimentTraceArms rolls up arm, experiment, and multi-arm counts", () => {
  // Insertion order is deliberately not sorted, to prove the fold sorts output.
  const grain: ExperimentTraceArm[] = [
    {
      experimentName: "checkout",
      arm: "control",
      traceId: "t1",
      firstSeenAt: new Date("2026-07-30T10:00:00.000Z"),
      lastSeenAt: new Date("2026-07-30T10:05:00.000Z"),
    },
    {
      experimentName: "checkout",
      arm: "control",
      traceId: "t2",
      firstSeenAt: new Date("2026-07-30T09:00:00.000Z"),
      lastSeenAt: new Date("2026-07-30T09:30:00.000Z"),
    },
    {
      experimentName: "checkout",
      arm: "variant",
      traceId: "t3",
      firstSeenAt: new Date("2026-07-30T11:00:00.000Z"),
      lastSeenAt: new Date("2026-07-30T11:00:00.000Z"),
    },
    // t3 also has a control arm => t3 is a multi-arm trace for checkout.
    {
      experimentName: "checkout",
      arm: "control",
      traceId: "t3",
      firstSeenAt: new Date("2026-07-30T11:05:00.000Z"),
      lastSeenAt: new Date("2026-07-30T11:10:00.000Z"),
    },
    // A second experiment whose traces each stay on one arm => no multi-arm row.
    {
      experimentName: "audit",
      arm: "b",
      traceId: "t4",
      firstSeenAt: new Date("2026-07-30T08:00:00.000Z"),
      lastSeenAt: new Date("2026-07-30T08:00:00.000Z"),
    },
    {
      experimentName: "audit",
      arm: "a",
      traceId: "t5",
      firstSeenAt: new Date("2026-07-30T07:00:00.000Z"),
      lastSeenAt: new Date("2026-07-30T07:30:00.000Z"),
    },
  ];

  const { armAggregates, multiArmCounts } = foldExperimentTraceArms(grain);

  assert.deepEqual(armAggregates, [
    {
      experimentName: "audit",
      arm: "a",
      traceCount: 1,
      experimentTraceCount: 2,
      firstSeenAt: new Date("2026-07-30T07:00:00.000Z"),
      lastSeenAt: new Date("2026-07-30T07:30:00.000Z"),
    },
    {
      experimentName: "audit",
      arm: "b",
      traceCount: 1,
      experimentTraceCount: 2,
      firstSeenAt: new Date("2026-07-30T08:00:00.000Z"),
      lastSeenAt: new Date("2026-07-30T08:00:00.000Z"),
    },
    {
      experimentName: "checkout",
      arm: "control",
      traceCount: 3,
      experimentTraceCount: 3,
      firstSeenAt: new Date("2026-07-30T09:00:00.000Z"),
      lastSeenAt: new Date("2026-07-30T11:10:00.000Z"),
    },
    {
      experimentName: "checkout",
      arm: "variant",
      traceCount: 1,
      experimentTraceCount: 3,
      firstSeenAt: new Date("2026-07-30T11:00:00.000Z"),
      lastSeenAt: new Date("2026-07-30T11:00:00.000Z"),
    },
  ]);

  assert.deepEqual(multiArmCounts, [{ experimentName: "checkout", traceCount: 1 }]);
});

test("foldExperimentTraceArms returns empty rollups for empty grain", () => {
  assert.deepEqual(foldExperimentTraceArms([]), {
    armAggregates: [],
    multiArmCounts: [],
  });
});
