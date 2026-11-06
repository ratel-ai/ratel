import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ArmPairAgreementSummary,
  ExperimentCalibrationSummary,
  RankingCalibrationView,
  RankingComparisonRowView,
} from "@/lib/synthesis/experiments/calibration-types";
import type {
  ExperimentLifecycleArmMetrics,
  ExperimentSummary,
} from "@/lib/synthesis/experiments/types";
import {
  disagreementKind,
  experimentKpis,
  pickExperiment,
  rowsToMeasure,
  toDisagreementRows,
  toExperimentRows,
} from "./experiments";

const SIDE = {
  outcomes: {},
  errorRate: null,
  averageDurationMs: null,
  p50DurationMs: null,
  p95DurationMs: null,
};

function pair(overrides: Partial<ArmPairAgreementSummary>): ArmPairAgreementSummary {
  return {
    servedArm: "control",
    shadowArm: "shadow",
    comparisonCount: 30,
    mismatchCount: 9,
    top1Rate: 0.8,
    exactOrderRate: 0.7,
    averageJaccardAtK: 0.9,
    jaccardByK: [],
    served: SIDE,
    shadow: SIDE,
    ...overrides,
  };
}

function lifecycle(arm: string, shadowCoverage: number | null): ExperimentLifecycleArmMetrics {
  return {
    arm,
    role: "shadow",
    comparisonCount: 30,
    top1Rate: null,
    exactOrderRate: null,
    averageJaccardAtK: null,
    agreementK: null,
    skipCount: 1,
    fallbackCount: 0,
    dropCount: 2,
    dropsByReason: {},
    shadowCoverage,
  };
}

function view(overrides: Partial<RankingCalibrationView> = {}): RankingCalibrationView {
  return {
    name: "reranker-shadow",
    kind: "ranking-shadow",
    pairs: [pair({})],
    arms: [],
    lifecycle: [lifecycle("shadow", 0.82)],
    comparisons: [],
    totalComparisonCount: 40,
    mismatchCount: 13,
    filteredComparisonCount: 13,
    ...overrides,
  };
}

test("the three numbers weigh every direction by its comparisons", () => {
  const kpis = experimentKpis(
    view({
      pairs: [
        pair({ comparisonCount: 30, top1Rate: 0.8, exactOrderRate: 0.7 }),
        pair({
          servedArm: "shadow",
          shadowArm: "control",
          comparisonCount: 10,
          top1Rate: 0.4,
          exactOrderRate: null,
        }),
      ],
      lifecycle: [lifecycle("control", 0.1), lifecycle("shadow", 0.82)],
    }),
  );
  assert.equal(kpis.firstPick, 0.7);
  assert.equal(
    kpis.sameOrder,
    0.7,
    "a direction without the figure is left out, not counted as zero",
  );
  assert.equal(kpis.coverage, 0.82, "coverage is the busiest direction's comparison variant");
  assert.equal(kpis.current, "control");
  assert.equal(kpis.comparison, "shadow");
  assert.equal(kpis.comparisons, 40);
  assert.equal(kpis.disagreements, 13);
  const empty = experimentKpis(view({ pairs: [], lifecycle: [] }));
  assert.deepEqual(
    [empty.firstPick, empty.sameOrder, empty.coverage, empty.current],
    [null, null, null, null],
  );
});

function experiment(name: string, lastSeen: string, traceCount = 5): ExperimentSummary {
  return {
    name,
    mode: "shadow",
    baselineArm: "control",
    traceCount,
    multiArmTraceCount: 0,
    arms: [],
    firstSeenAt: new Date("2026-09-01T00:00:00Z"),
    lastSeenAt: new Date(lastSeen),
  };
}

test("experiments that compared rankings come first, busiest first; the rest by recency", () => {
  const summaries = new Map<string, ExperimentCalibrationSummary>([
    ["small", { kind: "ranking-shadow", comparisonCount: 4, mismatchCount: 1 }],
    ["big", { kind: "ranking-shadow", comparisonCount: 40, mismatchCount: 13 }],
    ["ab", { kind: "generic", comparisonCount: 0, mismatchCount: 0 }],
  ]);
  const rows = toExperimentRows(
    [
      experiment("ab", "2026-10-14T00:00:00Z", 36),
      experiment("small", "2026-10-10T00:00:00Z"),
      experiment("big", "2026-09-14T00:00:00Z"),
      experiment("unknown", "2026-10-15T00:00:00Z"),
    ],
    summaries,
    new Map([["big", experimentKpis(view())]]),
  );
  assert.deepEqual(
    rows.map((row) => [row.name, row.kind]),
    [
      ["big", "ranking"],
      ["small", "ranking"],
      ["unknown", "other"],
      ["ab", "other"],
    ],
  );
  assert.equal(rows[0]!.kpis?.firstPick, 0.8);
  assert.equal(rows[1]!.kpis, null, "not measured, so no numbers rather than zeros");
  assert.equal(rows[3]!.runs, 36);
  assert.deepEqual(
    rowsToMeasure(rows, rows[1]!, 1).map((row) => row.name),
    ["big", "small"],
    "the open experiment is read even past the busiest few",
  );
  assert.deepEqual(
    rowsToMeasure(rows, rows[0]!, 1).map((row) => row.name),
    ["big"],
    "never twice",
  );
  assert.deepEqual(
    rowsToMeasure(rows, rows[3]!, 5).map((row) => row.name),
    ["big", "small"],
    "a plain A/B has nothing to measure",
  );
  assert.equal(pickExperiment(rows, "ab")?.name, "ab", "the one asked for");
  assert.equal(pickExperiment(rows, "missing")?.name, "big", "else the busiest comparison");
  assert.equal(
    pickExperiment(
      rows.filter((row) => row.kind === "other"),
      null,
    ),
    null,
  );
});

function comparison(overrides: Partial<RankingComparisonRowView> = {}): RankingComparisonRowView {
  return {
    selectionId: "sel-1",
    occurredAt: new Date("2026-09-13T15:14:13.332Z"),
    traceId: "abc",
    query: "check my diff for risky changes",
    servedArm: "control",
    shadowArm: "shadow",
    servedOutcome: "ok",
    shadowOutcome: "ok",
    servedDurationMs: 12,
    shadowDurationMs: 30,
    top1: false,
    exactOrder: false,
    agreementK: 3,
    matchScore: 0.5,
    servedResultIds: ["review_pr", "test_runner", "github_api"],
    shadowResultIds: ["test_runner", "review_pr"],
    servedResultScores: null,
    shadowResultScores: null,
    diffSummary: null,
    ...overrides,
  };
}

test("each disagreement says what differs, and marks every tool against the other list", () => {
  const [row] = toDisagreementRows([comparison()], {
    name: (id) => id.replace("_", " "),
    traceHref: (item) => (item.traceId ? `/trace/${item.traceId}` : null),
    test: (item) =>
      item.selectionId
        ? { kind: "selection", selectionId: item.selectionId, experimentName: "cal" }
        : null,
  });
  assert.equal(row!.id, "sel-1");
  assert.equal(row!.kind, "first-pick");
  assert.equal(row!.occurredAt, "2026-09-13T15:14:13.332Z");
  assert.deepEqual(
    row!.current.items.map((item) => [item.name, item.mark, item.otherRank]),
    [
      ["review pr", "moved", 2],
      ["test runner", "moved", 1],
      ["github api", "only", null],
    ],
  );
  assert.deepEqual(
    row!.comparison.items.map((item) => item.mark),
    ["moved", "moved"],
  );
  assert.equal(row!.traceHref, "/trace/abc");
  assert.deepEqual(
    row!.test,
    { kind: "selection", selectionId: "sel-1", experimentName: "cal" },
    "a search reopens by its ids",
  );
  const anonymous = toDisagreementRows([comparison({ selectionId: null, servedArm: null })], {
    name: (id) => id,
    traceHref: () => null,
    test: () => null,
  })[0]!;
  assert.match(anonymous.id, /^comparison-/);
  assert.equal(anonymous.current.arm, "Current");
});

test("the kind of disagreement comes from the recorded flag, else the lists", () => {
  assert.equal(disagreementKind(false, ["a"], ["a"]), "first-pick", "the recorded flag wins");
  assert.equal(disagreementKind(true, ["a", "b"], ["a", "c"]), "results");
  assert.equal(disagreementKind(true, ["a", "b", "c"], ["a", "c", "b"]), "order");
  assert.equal(disagreementKind(null, ["a", "b"], ["b", "a"]), "first-pick");
  assert.equal(disagreementKind(null, [], []), "results", "nothing recorded, nothing claimed");
});
