import assert from "node:assert/strict";
import { test } from "node:test";
import type { Eval, EvalResult, EvalVerdict } from "../domain/types";
import { changeText, definitionRows, parseRunFilter, runSummary, runTable } from "../view";

const NOW = new Date("2026-11-08T09:10:00Z");
const anEval = (id: string, tasks: string[], over: Partial<Eval> = {}): Eval => ({
  id,
  projectId: "p",
  name: `Eval ${id}`,
  sourceTurnId: null,
  sourceCaseId: null,
  message: "m",
  earlierMessages: [],
  turns: [],
  checks: {},
  expectedTool: null,
  criteria: "",
  fixedAnswers: [],
  status: "approved",
  origin: "user",
  tasks,
  createdBy: "t",
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});
const v = (kind: EvalVerdict["kind"], status: EvalVerdict["status"]): EvalVerdict => ({
  kind,
  status,
  measured: null,
  limit: null,
  detail: "",
});
const aResult = (
  evalId: string,
  passed: boolean | null,
  verdicts: EvalVerdict[] = [],
  over: Partial<EvalResult> = {},
): EvalResult => ({
  id: `r-${evalId}`,
  projectId: "p",
  runId: "run",
  evalId,
  side: "before",
  passed,
  verdicts,
  change: null,
  durationMs: null,
  costUsd: null,
  toolCalls: null,
  toolAnswers: [],
  transcript: null,
  error: null,
  createdAt: NOW,
  ...over,
});
const NAMES = new Map([
  ["wf-1", "Rebook a flight"],
  ["wf-2", "Refund status"],
]);

test("definitions: tasks by name, check count, last 6 oldest first padded, last result; filter by task", () => {
  const evals = [
    anEval("a", ["wf-1", "wf-2"]),
    anEval("b", ["wf-2"], { checks: { ends_well: { on: false } } }),
  ];
  const recent = new Map([
    ["a", [aResult("a", false), aResult("a", true), aResult("a", null, [], { error: "gone" })]],
  ]);
  const scorers = new Map([
    ["wf-1", [{ kind: "ends_well" as const }, { kind: "max_tool_calls" as const, max: 3 }]],
    ["wf-2", [{ kind: "max_tool_calls" as const, max: 2 }, { kind: "ends_well" as const }]],
  ]);
  const rows = definitionRows(evals, recent, scorers, NAMES);
  assert.deepEqual(rows[0], {
    id: "a",
    name: "Eval a",
    suggested: false,
    tasks: [
      { id: "wf-1", label: "Rebook a flight" },
      { id: "wf-2", label: "Refund status" },
    ],
    checks: 2,
    last6: ["none", "none", "none", "error", "pass", "fail"],
    last: "fail",
  });
  assert.equal(rows[1]!.checks, 1, "A check turned off does not count.");
  assert.equal(
    definitionRows([anEval("c", ["wf-1"], { status: "suggested" })], recent, scorers, NAMES)[0]!
      .suggested,
    true,
  );
  assert.equal(rows[1]!.last, null);
  assert.deepEqual(
    definitionRows(evals, recent, scorers, NAMES, "wf-1").map((row) => row.id),
    ["a"],
  );
});

test("run summary and its change text", () => {
  const results = [
    aResult("a", true, [], { change: "fixed" }),
    aResult("b", false, [], { change: "now_fails" }),
    aResult("c", true, [], { change: "same" }),
    aResult("d", null),
  ];
  const summary = runSummary(results);
  assert.deepEqual(summary, { passed: 2, total: 4, nowFails: 1, fixed: 1 });
  assert.equal(changeText(summary), "1 fixed · 1 now fails");
  assert.equal(changeText({ passed: 1, total: 1, nowFails: 0, fixed: 0 }), "");
  assert.equal(changeText({ passed: 1, total: 4, nowFails: 3, fixed: 0 }), "3 now fail");
});

test("run table: a column per scorer used, a check, cross or dot per cell, change outlined, filters", () => {
  const evals = [anEval("a", ["wf-1"]), anEval("b", ["wf-2"]), anEval("c", ["wf-1"])];
  const results = [
    aResult("a", false, [v("ends_well", "pass"), v("max_tool_calls", "fail")], {
      change: "now_fails",
    }),
    aResult("b", true, [v("max_tool_calls", "pass"), v("expected_tool", "skip")], {
      change: "same",
    }),
    aResult("c", null, [], { error: "The recorded run is gone." }),
  ];
  const all = runTable(results, evals, NAMES, "all");
  assert.deepEqual(all.columns, ["ends_well", "expected_tool", "max_tool_calls"]);
  assert.deepEqual(
    all.rows.map((row) => [
      row.evalId,
      row.cells.ends_well,
      row.cells.expected_tool,
      row.cells.max_tool_calls,
      row.change,
      row.outlined,
    ]),
    [
      ["a", "pass", "dot", "fail", "now_fails", true],
      ["b", "dot", "dot", "pass", "same", false],
      ["c", "dot", "dot", "dot", null, false],
    ],
  );
  assert.equal(all.rows[2]!.error, "The recorded run is gone.");
  assert.deepEqual(all.counts, { all: 3, failing: 2, changed: 1 });
  assert.deepEqual(
    runTable(results, evals, NAMES, "failing").rows.map((row) => row.evalId),
    ["a", "c"],
  );
  assert.deepEqual(
    runTable(results, evals, NAMES, "changed").rows.map((row) => row.evalId),
    ["a"],
  );
});

test("the run filter comes from the URL and falls back to all", () => {
  assert.equal(parseRunFilter("failing"), "failing");
  assert.equal(parseRunFilter("changed"), "changed");
  assert.equal(parseRunFilter("nope"), "all");
  assert.equal(parseRunFilter(undefined), "all");
});

test('RC-309: a run table row says "2 of 3" for an eval that ran several times, and nothing for one run', () => {
  const evals = [anEval("a", []), anEval("b", []), anEval("c", [])];
  const rows = runTable(
    [
      aResult("a", false, [], { attempts: { passed: 2, total: 3 } }),
      aResult("b", true),
      aResult("c", null, [], { attempts: { passed: 0, total: 3 } }),
    ],
    evals,
    NAMES,
    "all",
  ).rows;
  assert.deepEqual(
    rows.map((row) => row.attempts),
    ["2 of 3", null, null],
    "Not scored in any run: no pass rate to show.",
  );
});
