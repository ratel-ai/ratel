import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyChange } from "@/lib/views/eval-gate/change";
import { checkSide } from "@/lib/views/eval-gate/score";
import {
  type CheckKind,
  type Expected,
  NO_EXPECTATION,
  type RunView,
} from "@/lib/views/eval-gate/types";
import { type Scorer, scoreRun } from "@/lib/views/task-scorers";

// These views come from scoring.test.ts. Keep that test file unchanged.
const SCORING_FIXTURES: RunView[] = [
  {
    firstList: ["a"],
    searches: 1,
    calls: ["a", "b", "c"],
    outcomes: ["ok", "ok", "ok"],
    failed: 0,
    answered: true,
  },
  { firstList: ["a"], searches: null, calls: null, failed: null },
  {
    firstList: null,
    searches: null,
    calls: ["a", "a", "b"],
    outcomes: ["error", "error", "ok"],
    failed: 2,
  },
  { firstList: null, searches: null, calls: null, outcomes: null, failed: null },
  { firstList: null, searches: null, calls: ["a", "b"], outcomes: ["ok", "error"], failed: 1 },
  { firstList: null, searches: null, calls: ["a"], outcomes: ["ok"], failed: 0, answered: true },
  { firstList: null, searches: null, calls: ["a"], outcomes: ["ok"], failed: 0, answered: false },
  { firstList: null, searches: null, calls: ["a"], outcomes: ["error"], failed: 1 },
];

const SCORERS: Scorer[] = [
  { kind: "expected_tool", tool: "a" },
  { kind: "max_tool_calls", max: 2 },
  { kind: "ends_well" },
  { kind: "max_self_corrections", max: 1 },
  { kind: "max_cost_usd", max: 0.01 },
  { kind: "max_latency_ms", max: 1000 },
];

const EXPECTED: Expected = {
  ...NO_EXPECTATION,
  tool: "a",
  maxToolCalls: 2,
  endsWell: true,
  maxSelfCorrections: 1,
  maxCostUsd: 0.01,
  maxLatencyMs: 1000,
};

const CHECK_KIND = {
  judge_criteria: "criteria",
  expected_tool: "right_tool",
  max_tool_calls: "max_tool_calls",
  ends_well: "ends_well",
  max_self_corrections: "max_self_corrections",
  max_cost_usd: "max_cost",
  max_latency_ms: "max_latency",
} satisfies Record<Scorer["kind"], CheckKind>;

test("scoreRun matches checkSide on the scoring fixtures", () => {
  const fixtures = [
    ...SCORING_FIXTURES,
    { ...SCORING_FIXTURES[0]!, listKnown: false },
    { ...SCORING_FIXTURES[0]!, firstList: ["x", "y", "a"], costUsd: 0.01, latencyMs: 1001 },
    { ...SCORING_FIXTURES[0]!, firstList: [], costUsd: 0.02, latencyMs: 1000 },
  ];
  for (const view of fixtures) {
    const results = scoreRun(view, SCORERS);
    const side = checkSide(view, EXPECTED, null);
    assert.deepEqual(
      results.map((result) => ({
        kind: CHECK_KIND[result.kind],
        pass: result.status === "pass",
        measured: result.status !== "skip",
        score: result.score,
        detail: result.detail,
      })),
      side.checks.map(({ kind, pass, measured, score, detail }) => ({
        kind,
        pass,
        measured,
        score,
        detail,
      })),
    );
    assert.equal(results[0]!.rank ?? null, side.rank);
    const measured = results.filter((result) => result.status !== "skip");
    assert.equal(
      measured.length > 0 && measured.every((result) => result.status === "pass"),
      side.pass,
    );
  }
});

test("the gate retains fix mapping, extra checks and judge results in order", () => {
  const change = {
    ...emptyChange(),
    add: [{ id: "ab", name: "ab", searchable: "ab", replaces: ["a", "z"] }],
  };
  const view: RunView = {
    firstList: ["ab"],
    searches: 1,
    calls: ["ab"],
    outcomes: ["ok"],
    failed: 0,
    answered: true,
    costUsd: 0.005,
    latencyMs: 900,
  };
  const side = checkSide(
    view,
    { ...EXPECTED, maxSearches: 1, maxFailedCalls: 0, avoidTools: ["z"] },
    change,
    { criteria: true },
  );
  assert.deepEqual(
    side.checks.map(({ kind, pass, measured }) => [kind, pass, measured]),
    [
      ["right_tool", true, true],
      ["max_tool_calls", true, true],
      ["max_searches", true, true],
      ["max_failed_calls", true, true],
      ["avoid_tools", false, true],
      ["ends_well", true, true],
      ["max_self_corrections", true, true],
      ["max_cost", true, true],
      ["max_latency", true, true],
      ["criteria", true, true],
    ],
  );
  assert.deepEqual(
    { rank: side.rank, pass: side.pass, score: side.score },
    { rank: 1, pass: false, score: 0.9 },
  );
});
