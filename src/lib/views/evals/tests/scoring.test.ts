import assert from "node:assert/strict";
import { test } from "node:test";
import type { Scorer } from "@/lib/views/task-scorers/types";
import { changeFrom, effectiveScorers, verdictsOf } from "../domain/scoring";

const TASK_A: Scorer[] = [
  { kind: "ends_well" },
  { kind: "max_tool_calls", max: 6 },
  { kind: "max_cost_usd", max: 0.05 },
];
const TASK_B: Scorer[] = [
  { kind: "max_tool_calls", max: 4 },
  { kind: "max_cost_usd", max: 0.08 },
  { kind: "expected_tool", tool: "refund" },
];

test("an eval with two tasks gets every scorer of both, and the stricter limit wins", () => {
  const scorers = effectiveScorers([TASK_A, TASK_B], {
    checks: {},
    expectedTool: null,
    criteria: "",
  });
  assert.deepEqual(scorers, [
    { kind: "ends_well" },
    { kind: "max_cost_usd", max: 0.05 },
    { kind: "expected_tool", tool: "refund" },
    { kind: "max_tool_calls", max: 4 },
  ]);
});

test("an eval override wins over the task limit, even a looser one, and a check can be off", () => {
  const scorers = effectiveScorers([TASK_A, TASK_B], {
    checks: { max_tool_calls: { on: true, max: 10 }, ends_well: { on: false } },
    expectedTool: "refund_order",
    criteria: "Says the refund amount",
  });
  assert.deepEqual(scorers, [
    { kind: "max_cost_usd", max: 0.05 },
    { kind: "expected_tool", tool: "refund_order" },
    { kind: "max_tool_calls", max: 10 },
    { kind: "judge_criteria", criteria: "Says the refund amount" },
  ]);
});

test("an eval can turn on a check its tasks lack when it has the limit", () => {
  const scorers = effectiveScorers([], {
    checks: {
      ends_well: { on: true },
      max_latency_ms: { on: true, max: 5000 },
      max_cost_usd: { on: true },
    },
    expectedTool: null,
    criteria: "",
  });
  assert.deepEqual(scorers, [{ kind: "ends_well" }, { kind: "max_latency_ms", max: 5000 }]);
});

test("verdicts: measured value and limit per scorer; one fail fails the eval; a scorer that does not apply is a skip", () => {
  const scorers: Scorer[] = [
    { kind: "max_tool_calls", max: 2 },
    { kind: "expected_tool", tool: "refund" },
    { kind: "max_latency_ms", max: 1000 },
    { kind: "max_cost_usd", max: 0.1 },
  ];
  const { verdicts, passed } = verdictsOf(
    {
      calls: ["lookup", "refund", "refund"],
      firstList: null,
      listKnown: false,
      searches: null,
      failed: 0,
      latencyMs: 1500,
      costUsd: null,
    },
    scorers,
  );
  assert.deepEqual(
    verdicts.map((v) => [v.kind, v.status, v.measured, v.limit]),
    [
      ["max_tool_calls", "fail", 3, 2],
      ["expected_tool", "pass", "called", "refund"],
      ["max_latency_ms", "fail", 1500, 1000],
      ["max_cost_usd", "skip", null, 0.1],
    ],
  );
  assert.equal(passed, false);
  const notCalled = verdictsOf(
    { calls: ["lookup"], firstList: null, listKnown: false, searches: null, failed: 0 },
    [{ kind: "expected_tool", tool: "refund" }],
  );
  assert.deepEqual(
    [notCalled.verdicts[0]!.status, notCalled.verdicts[0]!.measured],
    ["fail", "not called"],
  );
  assert.equal(
    verdictsOf({ calls: null, firstList: null, listKnown: false, searches: null, failed: null }, [
      { kind: "expected_tool", tool: "x" },
    ]).passed,
    null,
    "Nothing measured: no verdict.",
  );
});

test("change from the run before: now fails, fixed, same, new", () => {
  assert.equal(changeFrom(true, false), "now_fails");
  assert.equal(changeFrom(false, true), "fixed");
  assert.equal(changeFrom(true, true), "same");
  assert.equal(changeFrom(false, false), "same");
  assert.equal(changeFrom(undefined, true), "new");
  assert.equal(
    changeFrom(null, false),
    "new",
    "A previous result with no verdict counts as no result.",
  );
  assert.equal(changeFrom(true, null), null, "No verdict now: no change to tell.");
});
