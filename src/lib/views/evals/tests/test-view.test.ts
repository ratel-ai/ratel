import assert from "node:assert/strict";
import { test } from "node:test";
import type { EvalResult } from "../domain/types";
import {
  attemptsLine,
  generatedLine,
  measuredText,
  neighbours,
  rulesWithSource,
  scorerSentence,
  sourceCounts,
  testSteps,
  totalsLine,
  turnRows,
} from "../test-view";

const RESULT: EvalResult = {
  id: "r",
  projectId: "p",
  runId: "run",
  evalId: "e",
  side: "before",
  passed: false,
  change: "now_fails",
  verdicts: [],
  durationMs: 14_000,
  costUsd: 0.0194,
  toolCalls: 3,
  error: null,
  createdAt: new Date(),
  toolAnswers: [
    { tool: "find_booking", source: "recorded", reason: "matched_recording", ms: 480 },
    { tool: "seat_map_then_select", source: "composed", reason: "merged_from_sources", ms: 900 },
    { tool: "send_message", source: "stand-in", reason: "stand_in_model", ms: 490 },
  ],
  transcript: {
    toolsOffered: ["find_booking", "seat_map_then_select", "send_message"],
    steps: [
      { role: "assistant", text: "", calls: [{ name: "find_booking", args: { ref: "R1" } }] },
      { role: "tool", tool: "find_booking", content: '{"booking":"R1"}', isError: false },
      {
        role: "assistant",
        text: "",
        calls: [{ name: "seat_map_then_select", args: { seat: "23A" } }],
      },
      { role: "tool", tool: "seat_map_then_select", content: '{"error":"taken"}', isError: true },
      { role: "assistant", text: "", calls: [{ name: "send_message", args: { to: "me" } }] },
      { role: "tool", tool: "send_message", content: '{"ok":true}', isError: false },
      { role: "assistant", text: "Seat 23A is yours.", calls: [] },
    ],
  },
};

test("each scorer reads as a sentence with its limit", () => {
  assert.equal(
    scorerSentence({ kind: "ends_well" }),
    "The last tool call succeeds and the agent replies",
  );
  assert.equal(scorerSentence({ kind: "max_self_corrections", max: 0 }), "No self-corrections");
  assert.equal(
    scorerSentence({ kind: "max_self_corrections", max: 2 }),
    "At most 2 self-corrections",
  );
  assert.equal(scorerSentence({ kind: "max_cost_usd", max: 0.0177 }), "Costs at most $0.0177");
  assert.equal(scorerSentence({ kind: "max_latency_ms", max: 12_700 }), "Takes at most 12.7 s");
  assert.equal(scorerSentence({ kind: "max_tool_calls", max: 1 }), "At most 1 tool call");
  assert.equal(
    scorerSentence({ kind: "expected_tool", tool: "get_seat_map" }),
    "Calls get_seat_map",
  );
  assert.equal(
    scorerSentence({ kind: "judge_criteria", criteria: "Says the new seat" }),
    "Says the new seat",
  );
});

test("measured values read in the scorer's unit", () => {
  assert.equal(
    measuredText({
      kind: "max_cost_usd",
      status: "fail",
      measured: 0.0194,
      limit: 0.0177,
      detail: "",
    }),
    "$0.0194",
  );
  assert.equal(
    measuredText({
      kind: "max_latency_ms",
      status: "fail",
      measured: 14_000,
      limit: 1,
      detail: "",
    }),
    "14 s",
  );
  assert.equal(
    measuredText({
      kind: "max_self_corrections",
      status: "fail",
      measured: 1,
      limit: 0,
      detail: "",
    }),
    "1",
  );
  assert.equal(
    measuredText({
      kind: "expected_tool",
      status: "pass",
      measured: "called",
      limit: "x",
      detail: "",
    }),
    "called",
  );
  assert.equal(
    measuredText({
      kind: "ends_well",
      status: "skip",
      measured: null,
      limit: null,
      detail: "not measured",
    }),
    "not measured",
  );
});

test("which rules the eval set itself and which come from its tasks", () => {
  const rules = rulesWithSource(
    [
      { kind: "ends_well" },
      { kind: "max_tool_calls", max: 5 },
      { kind: "expected_tool", tool: "x" },
    ],
    { checks: { max_tool_calls: { on: true, max: 5 } }, expectedTool: "x", criteria: "" },
  );
  assert.deepEqual(
    rules.map((rule) => [rule.scorer.kind, rule.setBy]),
    [
      ["ends_well", "task"],
      ["max_tool_calls", "eval"],
      ["expected_tool", "eval"],
    ],
  );
});

test("source counts line: from its sources first, then recorded, earlier, stand-in", () => {
  assert.deepEqual(sourceCounts(RESULT.toolAnswers), [
    { source: "composed", count: 1, label: "1 merged" },
    { source: "recorded", count: 1, label: "1 recorded" },
    { source: "stand-in", count: 1, label: "1 simulated answer" },
  ]);
});

test("steps join the transcript with each answer's source, rule and reason", () => {
  const { steps, textKept } = testSteps(RESULT);
  assert.equal(textKept, true);
  assert.deepEqual(
    steps.map((step) =>
      step.kind === "tool" ? [step.tool, step.source, step.isError] : [step.kind, step.text],
    ),
    [
      ["find_booking", "recorded", false],
      ["seat_map_then_select", "composed", true],
      ["send_message", "stand-in", false],
      ["reply", "Seat 23A is yours."],
    ],
  );
  const standIn = steps[2]!;
  assert.ok(standIn.kind === "tool" && /Check it before you trust the result/.test(standIn.rule));
  assert.ok(
    standIn.kind === "tool" &&
      standIn.reason.length > 0 &&
      standIn.args === '{\n  "to": "me"\n}' &&
      standIn.result === '{\n  "ok": true\n}',
  );
});

test("without a transcript the steps keep sources and times but no text", () => {
  const { steps, textKept } = testSteps({ ...RESULT, transcript: null });
  assert.equal(textKept, false);
  assert.deepEqual(
    steps.map((step) =>
      step.kind === "tool" ? [step.tool, step.source, step.ms, step.args, step.result] : step.kind,
    ),
    [
      ["find_booking", "recorded", 480, null, null],
      ["seat_map_then_select", "composed", 900, null, null],
      ["send_message", "stand-in", 490, null, null],
    ],
  );
});

test("totals line and prev/next within a run", () => {
  assert.equal(totalsLine(RESULT), "14 s · $0.0194 · 3 tool calls");
  assert.deepEqual(neighbours(["a", "b", "c"], "b"), { index: 2, total: 3, prev: "a", next: "c" });
  assert.deepEqual(neighbours(["a", "b", "c"], "a"), { index: 1, total: 3, prev: null, next: "b" });
  assert.equal(neighbours(["a"], "z"), null);
});

test('RC-295, RC-657: a fixed answer reads as "fixed answer", comes first in the counts, and shows its reason', () => {
  const answers = [
    ...RESULT.toolAnswers,
    {
      tool: "get_fare",
      source: "mock" as const,
      reason: "fixed_answer" as const,
      ms: 0,
      why: "Fares are frozen",
    },
  ];
  assert.deepEqual(sourceCounts(answers)[0], { source: "mock", count: 1, label: "1 fixed answer" });
  const [step] = testSteps({ toolAnswers: answers.slice(3), transcript: null }).steps;
  assert.ok(step!.kind === "tool" && step!.source === "mock");
  assert.ok(
    step!.kind === "tool" &&
      /wins over the recording/.test(step!.rule) &&
      /Why: Fares are frozen$/.test(step!.reason),
  );
});

test("RC-309: the pass rate shows only for a result that ran several times", () => {
  assert.equal(
    attemptsLine({ ...RESULT, attempts: { passed: 2, total: 3 } }),
    "Passed 2 of 3 runs",
  );
  assert.equal(attemptsLine({ ...RESULT, attempts: { passed: 1, total: 1 } }), "Passed 1 of 1 run");
  assert.equal(
    attemptsLine({ ...RESULT, passed: null, attempts: { passed: 0, total: 3 } }),
    "Not scored in 3 runs",
  );
  assert.equal(
    attemptsLine({
      ...RESULT,
      passed: null,
      error: "Budget spent",
      attempts: { passed: 1, total: 2 },
    }),
    "Passed 1 of 2 runs before it stopped",
  );
  assert.equal(attemptsLine(RESULT), null);
  assert.equal(attemptsLine({ ...RESULT, attempts: null }), null);
});

test("RC-309: each turn reads as a row with its kind, result, message and verdicts", () => {
  const rows = turnRows({
    ...RESULT,
    turns: [
      {
        simulated: false,
        message: "Rebook me",
        passed: true,
        verdicts: [{ kind: "max_tool_calls", status: "pass", measured: 2, limit: 3, detail: "" }],
        answers: 2,
      },
      {
        simulated: true,
        message: null,
        passed: false,
        verdicts: [{ kind: "max_tool_calls", status: "fail", measured: 4, limit: 3, detail: "" }],
        answers: 4,
      },
      { simulated: false, message: "Thanks", passed: null, verdicts: [], answers: 0 },
    ],
  });
  assert.deepEqual(rows, [
    {
      label: "Turn 1",
      kind: "Fixed message",
      status: "pass",
      message: "Rebook me",
      verdicts: [{ kind: "max_tool_calls", label: "Tool calls", status: "pass", measured: "2" }],
    },
    {
      label: "Turn 2",
      kind: "Simulated person",
      status: "fail",
      message: null,
      verdicts: [{ kind: "max_tool_calls", label: "Tool calls", status: "fail", measured: "4" }],
    },
    { label: "Turn 3", kind: "Fixed message", status: "none", message: "Thanks", verdicts: [] },
  ]);
  assert.equal(turnRows(RESULT), null, "A single-turn result has no turn rows.");
  assert.equal(turnRows({ ...RESULT, turns: null }), null);
});

test("RC-609: the result names each model-written input it used, in spec order", () => {
  assert.equal(generatedLine({}), null);
  assert.equal(generatedLine({ generated: [] }), null);
  assert.equal(
    generatedLine({ generated: ["context"] }),
    "A model wrote the context values of this run: the recording did not have it. A pass that rests on it is unverified.",
  );
  assert.equal(
    generatedLine({ generated: ["tools", "systemPrompt", "message"] }),
    "A model wrote the system prompt, message and tool list of this run: the recording did not have them. A pass that rests on them is unverified.",
  );
});
