import assert from "node:assert/strict";
import { test } from "node:test";
import { SCORER_KINDS, type ScorerKind } from "@/lib/views/task-scorers/types";
import {
  type EvalForm,
  fixedAnswerFromStep,
  formFromEval,
  limitHint,
  parseEvalForm,
} from "../domain/edit";
import type { Eval } from "../domain/types";

const NOW = new Date("2026-11-08T10:00:00Z");
const ITEM: Eval = {
  id: "e",
  projectId: "p",
  name: "Aisle seat",
  sourceTurnId: "t",
  sourceCaseId: null,
  message: "Move me to an aisle seat",
  earlierMessages: [
    { role: "user", text: "Hi" },
    { role: "tool", tool: "find_booking", args: { ref: "R1" }, text: '{"booking":"R1"}' },
  ],
  turns: [
    { kind: "message", text: "Is it free?" },
    { kind: "person", description: "A hurried traveler" },
  ],
  checks: { max_latency_ms: { on: true, max: 12_700 }, max_tool_calls: { on: false } },
  expectedTool: null,
  criteria: "",
  fixedAnswers: [
    {
      tool: "select_seat",
      result: { seat: "14C" },
      when: { seat: "14C" },
      why: "Free on this fare",
    },
  ],
  status: "approved",
  origin: "user",
  tasks: ["wf-1"],
  createdBy: "u",
  createdAt: NOW,
  updatedAt: NOW,
};
const off = Object.fromEntries(
  SCORER_KINDS.map((kind) => [kind, { on: false, max: "" }]),
) as Record<ScorerKind, { on: boolean; max: string }>;
const form = (over: Partial<EvalForm> = {}): EvalForm => ({
  name: "Aisle seat",
  earlier: [],
  turns: [],
  tasks: [],
  checks: off,
  expectedTool: "",
  criteria: "",
  fixedAnswers: [],
  ...over,
});
const error = (over: Partial<EvalForm>) => {
  const parsed = parseEvalForm(form(over));
  return parsed.ok ? null : parsed.error;
};

test("RC-297: the form of a saved eval reads back to the same eval", () => {
  const start = formFromEval(ITEM, [
    { kind: "ends_well" },
    { kind: "max_latency_ms", max: 12_700 },
  ]);
  assert.equal(start.checks.max_latency_ms.max, "12.7", "Run time shows in seconds.");
  assert.equal(start.checks.ends_well.on, true);
  assert.equal(start.checks.max_tool_calls.on, false);
  assert.deepEqual(start.earlier[1], {
    role: "tool",
    tool: "find_booking",
    args: '{"ref":"R1"}',
    text: '{"booking":"R1"}',
  });
  assert.deepEqual(start.turns, [
    { kind: "message", text: "Is it free?" },
    { kind: "person", text: "A hurried traveler" },
  ]);
  const parsed = parseEvalForm(start);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  assert.deepEqual(parsed.value.earlierMessages, ITEM.earlierMessages);
  assert.deepEqual(parsed.value.turns, ITEM.turns);
  assert.deepEqual(parsed.value.fixedAnswers, ITEM.fixedAnswers);
  assert.deepEqual(parsed.value.checks.max_latency_ms, { on: true, max: 12_700 });
  assert.deepEqual(parsed.value.checks.ends_well, { on: true });
  assert.deepEqual(parsed.value.checks.max_tool_calls, { on: false });
});

test("RC-297: a name is required and kept short", () => {
  assert.equal(error({ name: "  " }), "Give the eval a name.");
  assert.match(error({ name: "x".repeat(201) })!, /under 200/);
});

test("RC-297: earlier messages and turns need words; a tool call needs a tool and JSON arguments", () => {
  assert.equal(error({ earlier: [{ role: "user", text: " " }] }), "Earlier message 1 is empty.");
  assert.equal(
    error({ earlier: [{ role: "tool", tool: "", args: "", text: "" }] }),
    "Earlier message 1: choose the tool it called.",
  );
  assert.match(
    error({ earlier: [{ role: "tool", tool: "x", args: "[1]", text: "" }] })!,
    /JSON object/,
  );
  assert.equal(error({ turns: [{ kind: "message", text: "" }] }), "Turn 2 is empty.");
  assert.equal(
    error({ turns: [{ kind: "person", text: "" }] }),
    "Turn 2: describe the simulated person.",
  );
});

test("RC-297: limits are positive numbers in the editor's unit; self-corrections may be 0", () => {
  const withCheck = (kind: ScorerKind, max: string) => ({
    checks: { ...off, [kind]: { on: true, max } },
  });
  assert.match(error(withCheck("max_cost_usd", "0"))!, /Cost: the limit must be a number above 0/);
  assert.match(
    error(withCheck("max_tool_calls", "1.5"))!,
    /Tool calls: the limit must be a whole number of at least 1/,
  );
  assert.match(error(withCheck("max_latency_ms", "-2"))!, /Run time/);
  const ok = parseEvalForm(
    form({
      checks: {
        ...off,
        max_self_corrections: { on: true, max: "0" },
        max_cost_usd: { on: true, max: "$0.02" },
        max_latency_ms: { on: true, max: "3 s" },
      },
    }),
  );
  assert.ok(ok.ok);
  assert.deepEqual(
    [
      ok.value.checks.max_self_corrections,
      ok.value.checks.max_cost_usd,
      ok.value.checks.max_latency_ms,
    ],
    [
      { on: true, max: 0 },
      { on: true, max: 0.02 },
      { on: true, max: 3000 },
    ],
  );
});

test("RC-297: an expected tool or criteria check that is on needs its value", () => {
  assert.match(
    error({ checks: { ...off, expected_tool: { on: true, max: "" } } })!,
    /Choose the expected tool/,
  );
  assert.match(
    error({ checks: { ...off, judge_criteria: { on: true, max: "" } } })!,
    /Write the criteria/,
  );
});

test("RC-297: a fixed answer has a tool, an answer, and JSON or nothing for when; text answers stay text", () => {
  assert.equal(
    error({ fixedAnswers: [{ tool: "", when: "", answer: "x", why: "" }] }),
    "Fixed answer 1: choose the tool it answers.",
  );
  assert.match(
    error({ fixedAnswers: [{ tool: "pay", when: "seat 14C", answer: "x", why: "" }] })!,
    /"When" must be JSON/,
  );
  assert.equal(
    error({ fixedAnswers: [{ tool: "pay", when: "", answer: " ", why: "" }] }),
    "Fixed answer 1: write the answer the tool gives.",
  );
  const parsed = parseEvalForm(
    form({
      fixedAnswers: [{ tool: "note", when: "{}", answer: "Seat changes are free", why: " " }],
    }),
  );
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value.fixedAnswers, [{ tool: "note", result: "Seat changes are free" }]);
});

test("RC-297: tasks are deduped and sorted", () => {
  const parsed = parseEvalForm(form({ tasks: ["wf-b", "wf-a", "wf-b", " "] }));
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value.tasks, ["wf-a", "wf-b"]);
});

test('RC-297: "Set a fixed answer for this tool" fills the tool, its arguments as the condition and what it returned', () => {
  assert.deepEqual(
    fixedAnswerFromStep({
      tool: "select_seat",
      args: '{\n  "seat": "14C"\n}',
      result: '{\n  "ok": true\n}',
    }),
    { tool: "select_seat", when: '{"seat":"14C"}', answer: '{\n  "ok": true\n}', why: "" },
  );
  assert.deepEqual(fixedAnswerFromStep({ tool: "select_seat", args: null, result: null }), {
    tool: "select_seat",
    when: "",
    answer: "",
    why: "",
  });
});

test("RC-297: the limit hint shows the task's stricter limit in the editor's unit", () => {
  assert.equal(
    limitHint("max_latency_ms", [
      { kind: "max_latency_ms", max: 12_700 },
      { kind: "max_latency_ms", max: 20_000 },
    ]),
    "From the task: ≤ 12.7 s",
  );
  assert.equal(
    limitHint("max_cost_usd", [{ kind: "max_cost_usd", max: 0.0177 }]),
    "From the task: ≤ $0.0177",
  );
  assert.equal(limitHint("max_tool_calls", []), "No limit from the task");
  assert.equal(limitHint("ends_well", []), null);
});
