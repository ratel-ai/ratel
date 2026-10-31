import assert from "node:assert/strict";
import { test } from "node:test";
import type { CalibrationQueries } from "./calibration-service";
import { createCalibrationService } from "./calibration-service";
import type {
  ArmPairAgreementSummary,
  ComparisonFilterSelection,
  RankingComparisonRow,
} from "./calibration-types";
import type { ExperimentLifecycleArmMetrics } from "./types";

const SINCE = new Date("2026-07-01T00:00:00.000Z");
const UNTIL = new Date("2026-08-01T00:00:00.000Z");
const WINDOW = { since: SINCE, until: UNTIL };

test("resolveCalibrationSummaries maps every requested name to its kind and census", async () => {
  const calls: Array<{ projectId: string; names: string[] }> = [];
  const service = createCalibrationService(
    queries({
      countExperimentComparisons: async (projectId, names) => {
        calls.push({ projectId, names });
        return [
          {
            experimentName: "reranker-shadow",
            comparisonCount: 12,
            mismatchCount: 2,
          },
          { experimentName: "checkout", comparisonCount: 0, mismatchCount: 0 },
        ];
      },
    }),
  );

  const summaries = await service.resolveCalibrationSummaries(
    "project-1",
    ["reranker-shadow", "checkout", "unseen"],
    WINDOW,
  );

  assert.deepEqual(
    summaries,
    new Map([
      ["reranker-shadow", { kind: "ranking-shadow", comparisonCount: 12, mismatchCount: 2 }],
      ["checkout", { kind: "generic", comparisonCount: 0, mismatchCount: 0 }],
      // Never counted in the window: absent from the count rows, not zeroed by
      // the query, so the fold has to supply the zero census itself.
      ["unseen", { kind: "generic", comparisonCount: 0, mismatchCount: 0 }],
    ]),
  );
  assert.deepEqual(calls, [
    {
      projectId: "project-1",
      names: ["reranker-shadow", "checkout", "unseen"],
    },
  ]);
});

test("getRankingCalibration returns null when no pairs and no comparison rows", async () => {
  const service = createCalibrationService(
    queries({
      listExperimentLifecycleArmMetrics: async () => [lifecycleMetrics()],
    }),
  );

  assert.equal(await service.getRankingCalibration("project-1", "checkout", WINDOW), null);
});

test("getRankingCalibration assembles view with totals and derived row facts", async () => {
  const pairs = [
    pair({ comparisonCount: 10, mismatchCount: 3 }),
    pair({
      servedArm: "ratel",
      shadowArm: "legacy",
      comparisonCount: 4,
      mismatchCount: 1,
    }),
  ];
  const lifecycle = [lifecycleMetrics()];
  const rows = [
    row({ selectionId: "sel-a", exactOrder: false, jaccardAtK: 0.5 }),
    row({
      selectionId: "sel-b",
      top1: null,
      exactOrder: null,
      overlapCount: null,
      jaccardAtK: null,
      agreementK: null,
    }),
    row({ selectionId: "sel-c", exactOrder: true, jaccardAtK: 1 }),
  ];
  const service = createCalibrationService(
    queries({
      // Census totals are arm-agnostic and can exceed the pair sums (14/4)
      // when comparison records miss arm attributes.
      countExperimentComparisons: async () => [
        {
          experimentName: "reranker-shadow",
          comparisonCount: 16,
          mismatchCount: 5,
        },
      ],
      getRankingComparisonSummary: async () => pairs,
      listRankingComparisons: async () => rows,
      countRankingComparisons: async () => 7,
      listExperimentLifecycleArmMetrics: async () => lifecycle,
    }),
  );

  const view = await service.getRankingCalibration("project-1", "reranker-shadow", WINDOW);
  const baseComparison = {
    occurredAt: new Date("2026-07-10T00:00:00.000Z"),
    traceId: "trace-1",
    query: null,
    servedArm: "legacy",
    shadowArm: "ratel",
    servedOutcome: "ok",
    shadowOutcome: "ok",
    servedDurationMs: 120,
    shadowDurationMs: 80,
    top1: true,
    agreementK: 3,
    servedResultIds: null,
    shadowResultIds: null,
    servedResultScores: null,
    shadowResultScores: null,
    diffSummary: null,
  };

  assert.deepEqual(view, {
    name: "reranker-shadow",
    kind: "ranking-shadow",
    pairs,
    arms: [
      {
        arm: "legacy",
        servingCount: 10,
        shadowingCount: 4,
        servingRate: 10 / 14,
        shadowingRate: 4 / 14,
      },
      {
        arm: "ratel",
        servingCount: 4,
        shadowingCount: 10,
        servingRate: 4 / 14,
        shadowingRate: 10 / 14,
      },
    ],
    lifecycle,
    comparisons: [
      {
        ...baseComparison,
        selectionId: "sel-a",
        exactOrder: false,
        matchScore: 0.5,
      },
      {
        ...baseComparison,
        selectionId: "sel-b",
        top1: null,
        exactOrder: null,
        agreementK: null,
        matchScore: null,
      },
      {
        ...baseComparison,
        selectionId: "sel-c",
        exactOrder: true,
        matchScore: 1,
      },
    ],
    totalComparisonCount: 16,
    mismatchCount: 5,
    filteredComparisonCount: 7,
  });
});

test("getRankingCalibration falls back to pair sums when the census count row is absent", async () => {
  const service = createCalibrationService(
    queries({
      getRankingComparisonSummary: async () => [
        pair({ comparisonCount: 10, mismatchCount: 3 }),
        pair({ servedArm: "legacy-v2", comparisonCount: 4, mismatchCount: 1 }),
      ],
    }),
  );

  const view = await service.getRankingCalibration("project-1", "reranker-shadow", WINDOW);

  assert.equal(view?.totalComparisonCount, 14);
  assert.equal(view?.mismatchCount, 4);
});

test("getRankingCalibration summarizes rankings only when both result id lists exist", async () => {
  const service = createCalibrationService(
    queries({
      getRankingComparisonSummary: async () => [pair()],
      listRankingComparisons: async () => [
        row({
          selectionId: "sel-both",
          servedResultIds: ["a", "b", "c"],
          shadowResultIds: ["a", "c", "d"],
        }),
        row({
          selectionId: "sel-served-only",
          servedResultIds: ["a", "b"],
          shadowResultIds: null,
        }),
        row({
          selectionId: "sel-shadow-only",
          servedResultIds: null,
          shadowResultIds: ["a", "b"],
        }),
      ],
    }),
  );

  const view = await service.getRankingCalibration("project-1", "reranker-shadow", WINDOW);

  assert.deepEqual(
    view?.comparisons.map(({ selectionId, diffSummary }) => ({
      selectionId,
      diffSummary,
    })),
    [
      {
        selectionId: "sel-both",
        diffSummary: { stable: 1, moved: 1, dropped: 1, added: 1 },
      },
      { selectionId: "sel-served-only", diffSummary: null },
      { selectionId: "sel-shadow-only", diffSummary: null },
    ],
  );
});

test("listComparisonPage returns compact browser rows and the filtered total", async () => {
  const service = createCalibrationService(
    queries({
      listRankingComparisons: async () => [
        row({
          servedResultIds: ["a", "b", "c"],
          shadowResultIds: ["c", "a"],
          exactOrder: false,
          jaccardAtK: 0.5,
        }),
      ],
      countRankingComparisons: async () => 42,
    }),
  );

  const page = await service.listComparisonPage("project-1", "reranker-shadow", WINDOW, {
    selection: { scope: "mismatch", facets: ["order"], match: "any" },
  });

  assert.equal(page.total, 42);
  assert.deepEqual(page.rows, [
    {
      selectionId: "sel-1",
      occurredAt: new Date("2026-07-10T00:00:00.000Z"),
      traceId: "trace-1",
      query: null,
      servedArm: "legacy",
      shadowArm: "ratel",
      servedOutcome: "ok",
      shadowOutcome: "ok",
      servedDurationMs: 120,
      shadowDurationMs: 80,
      top1: true,
      exactOrder: false,
      agreementK: 3,
      matchScore: 0.5,
      servedResultIds: ["a", "b", "c"],
      shadowResultIds: ["c", "a"],
      servedResultScores: null,
      shadowResultScores: null,
      diffSummary: { stable: 0, moved: 2, dropped: 1, added: 0 },
    },
  ]);
});

test("listComparisonPage clamps the row query offset to the final filtered page", async () => {
  const calls: unknown[][] = [];
  const service = createCalibrationService(
    queries({
      countRankingComparisons: async () => 40,
      listRankingComparisons: async (...args) => {
        calls.push(args);
        return [];
      },
    }),
  );

  await service.listComparisonPage("project-1", "reranker-shadow", WINDOW, {
    limit: 25,
    offset: 24_999_999_975,
  });

  assert.deepEqual(calls, [["project-1", "reranker-shadow", WINDOW, { limit: 25, offset: 25 }]]);
});

test("getRankingCalibration forwards scope and list options to queries", async () => {
  const calls: {
    summary: unknown[];
    list: unknown[];
    filteredCount: unknown[];
    lifecycle: unknown[];
  } = { summary: [], list: [], filteredCount: [], lifecycle: [] };
  const service = createCalibrationService(
    queries({
      getRankingComparisonSummary: async (...args) => {
        calls.summary.push(args);
        return [pair()];
      },
      listRankingComparisons: async (...args) => {
        calls.list.push(args);
        return [];
      },
      countRankingComparisons: async (...args) => {
        calls.filteredCount.push(args);
        return 0;
      },
      listExperimentLifecycleArmMetrics: async (...args) => {
        calls.lifecycle.push(args);
        return [];
      },
    }),
  );

  const selection: ComparisonFilterSelection = {
    scope: "mismatch",
    facets: ["order"],
    match: "any",
  };
  await service.getRankingCalibration("project-1", "reranker-shadow", WINDOW, {
    selection,
    limit: 25,
  });
  await service.getRankingCalibration("project-1", "reranker-shadow", WINDOW);

  assert.deepEqual(calls, {
    summary: [
      ["project-1", "reranker-shadow", WINDOW],
      ["project-1", "reranker-shadow", WINDOW],
    ],
    list: [
      ["project-1", "reranker-shadow", WINDOW, { selection, limit: 25 }],
      ["project-1", "reranker-shadow", WINDOW, {}],
    ],
    filteredCount: [
      ["project-1", "reranker-shadow", WINDOW, { selection, limit: 25 }],
      ["project-1", "reranker-shadow", WINDOW, {}],
    ],
    lifecycle: [
      ["project-1", "reranker-shadow", WINDOW],
      ["project-1", "reranker-shadow", WINDOW],
    ],
  });
});

function queries(overrides: Partial<CalibrationQueries>): CalibrationQueries {
  return {
    countExperimentComparisons: async () => [],
    getRankingComparisonSummary: async () => [],
    countRankingComparisons: async () => 0,
    listRankingComparisons: async () => [],
    listExperimentLifecycleArmMetrics: async () => [],
    ...overrides,
  };
}

function pair(overrides: Partial<ArmPairAgreementSummary> = {}): ArmPairAgreementSummary {
  return {
    servedArm: "legacy",
    shadowArm: "ratel",
    comparisonCount: 10,
    mismatchCount: 3,
    top1Rate: 0.9,
    exactOrderRate: 0.7,
    averageJaccardAtK: 0.8,
    jaccardByK: [{ k: 3, count: 10, mean: 0.8 }],
    served: sideStats(),
    shadow: sideStats(),
    ...overrides,
  };
}

function sideStats(): ArmPairAgreementSummary["served"] {
  return {
    outcomes: { ok: 10 },
    errorRate: 0,
    averageDurationMs: 100,
    p50DurationMs: 90,
    p95DurationMs: 150,
  };
}

function row(overrides: Partial<RankingComparisonRow> = {}): RankingComparisonRow {
  return {
    selectionId: "sel-1",
    occurredAt: new Date("2026-07-10T00:00:00.000Z"),
    traceId: "trace-1",
    query: null,
    servedArm: "legacy",
    shadowArm: "ratel",
    servedOutcome: "ok",
    shadowOutcome: "ok",
    servedDurationMs: 120,
    shadowDurationMs: 80,
    servedHitCount: 3,
    shadowHitCount: 3,
    top1: true,
    exactOrder: true,
    overlapCount: 3,
    jaccardAtK: 1,
    agreementK: 3,
    servedResultIds: null,
    shadowResultIds: null,
    servedResultScores: null,
    shadowResultScores: null,
    ...overrides,
  };
}

function lifecycleMetrics(): ExperimentLifecycleArmMetrics {
  return {
    arm: "ratel",
    role: "shadow",
    comparisonCount: 4,
    top1Rate: 0.75,
    exactOrderRate: 0.5,
    averageJaccardAtK: 0.8,
    agreementK: 3,
    skipCount: 1,
    fallbackCount: 2,
    dropCount: 1,
    dropsByReason: { timeout: 1 },
    shadowCoverage: 0.5,
  };
}
