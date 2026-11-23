import assert from "node:assert/strict";
import { test } from "node:test";
import { outcomeDefaults, type Scorer, type ScorerRun, scoreRun } from "@/lib/views/task-scorers";

const SCORERS: Scorer[] = [
  { kind: "ends_well" },
  { kind: "max_self_corrections", max: 1 },
  { kind: "max_latency_ms", max: 1000 },
  { kind: "max_cost_usd", max: 0.005 },
  { kind: "expected_tool", tool: "b" },
  { kind: "max_tool_calls", max: 2 },
];

const RECORDED: ScorerRun = {
  firstList: ["x", "y", "b"],
  searches: 1,
  calls: ["a", "a", "b"],
  outcomes: ["error", "error", "ok"],
  failed: 2,
  answered: true,
  costUsd: 0.01,
  latencyMs: 1000,
};

// The retry and the switch are two self-corrections. Rank 3 earns 0.75 credit.
test("scores each configured scorer with its measured result", () => {
  assert.deepEqual(scoreRun(RECORDED, SCORERS), [
    { kind: "ends_well", status: "pass", score: 1, detail: "ends well" },
    { kind: "max_self_corrections", status: "fail", score: 0, detail: "2 self-corrections" },
    { kind: "max_latency_ms", status: "pass", score: 1, detail: "1.0\u00a0s" },
    { kind: "max_cost_usd", status: "fail", score: 0, detail: "$0.01" },
    { kind: "expected_tool", status: "pass", score: 0.75, detail: "rank 3", rank: 3 },
    { kind: "max_tool_calls", status: "fail", score: 0, detail: "3 calls" },
  ]);
});

test("unknown measurements skip every scorer", () => {
  const unknown: ScorerRun = {
    firstList: null,
    listKnown: false,
    calls: null,
    searches: null,
    failed: null,
  };
  assert.deepEqual(scoreRun(unknown, SCORERS), [
    { kind: "ends_well", status: "skip", score: 0, detail: "not measured" },
    { kind: "max_self_corrections", status: "skip", score: 0, detail: "not measured" },
    { kind: "max_latency_ms", status: "skip", score: 0, detail: "not measured" },
    { kind: "max_cost_usd", status: "skip", score: 0, detail: "not measured" },
    { kind: "expected_tool", status: "skip", score: 0, detail: "not measured" },
    { kind: "max_tool_calls", status: "skip", score: 0, detail: "not measured" },
  ]);
});

test("zero measurements pass zero limits and an absent tool fails", () => {
  const empty: ScorerRun = {
    firstList: null,
    calls: [],
    outcomes: [],
    searches: 0,
    failed: 0,
    answered: true,
    costUsd: 0,
    latencyMs: 0,
  };
  const scorers: Scorer[] = [
    { kind: "ends_well" },
    { kind: "max_self_corrections", max: 0 },
    { kind: "max_latency_ms", max: 0 },
    { kind: "max_cost_usd", max: 0 },
    { kind: "expected_tool", tool: "a" },
    { kind: "max_tool_calls", max: 0 },
  ];
  assert.deepEqual(scoreRun(empty, scorers), [
    { kind: "ends_well", status: "pass", score: 1, detail: "ends well" },
    { kind: "max_self_corrections", status: "pass", score: 1, detail: "0 self-corrections" },
    { kind: "max_latency_ms", status: "pass", score: 1, detail: "0.0\u00a0s" },
    { kind: "max_cost_usd", status: "pass", score: 1, detail: "$0.0000" },
    { kind: "expected_tool", status: "fail", score: 0, detail: "no search", rank: null },
    { kind: "max_tool_calls", status: "pass", score: 1, detail: "0 calls" },
  ]);
  assert.deepEqual(scoreRun(empty, []), []);
});

test("outcomes preserve the recorded definitions of ending well and self-corrections", () => {
  const fixtures: { run: ScorerRun; statuses: string[]; corrections: string }[] = [
    {
      run: { ...RECORDED, calls: ["a", "b"], outcomes: ["ok", "error"] },
      statuses: ["fail", "pass"],
      corrections: "1 self-correction",
    },
    {
      run: { ...RECORDED, calls: ["a"], outcomes: ["ok"], answered: false },
      statuses: ["fail", "pass"],
      corrections: "0 self-corrections",
    },
    {
      run: { ...RECORDED, calls: ["a"], outcomes: ["unknown"], answered: null },
      statuses: ["pass", "pass"],
      corrections: "0 self-corrections",
    },
    {
      run: { ...RECORDED, calls: ["a"], outcomes: [] },
      statuses: ["skip", "skip"],
      corrections: "not measured",
    },
    {
      run: { ...RECORDED, calls: [], outcomes: [], answered: null },
      statuses: ["skip", "pass"],
      corrections: "0 self-corrections",
    },
  ];
  for (const { run, statuses, corrections } of fixtures) {
    const results = scoreRun(run, [
      { kind: "ends_well" },
      { kind: "max_self_corrections", max: 1 },
    ]);
    assert.deepEqual(
      results.map((result) => result.status),
      statuses,
    );
    assert.equal(results[1]!.detail, corrections);
  }
});

test("recorded outcome defaults retain rounding and unknown budgets", () => {
  const steps = [
    { kind: "invoke" as const, targetId: "a", outcome: "error" as const },
    { kind: "search" as const },
    { kind: "invoke" as const, targetId: "a", outcome: "error" as const },
    { kind: "invoke" as const, targetId: "b", outcome: "ok" as const },
  ];
  assert.deepEqual(outcomeDefaults({ steps, costUsd: 0.003, durationMs: 1001 }), {
    endsWell: true,
    maxSelfCorrections: 2,
    maxCostUsd: 0.0038,
    maxLatencyMs: 1252,
  });
  assert.deepEqual(outcomeDefaults({ steps: [], costUsd: 0, durationMs: null }), {
    endsWell: true,
    maxSelfCorrections: 0,
    maxCostUsd: null,
    maxLatencyMs: null,
  });
});
