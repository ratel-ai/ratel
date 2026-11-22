import assert from "node:assert/strict";
import { test } from "node:test";
import { type SimulationRow, suiteOfRun, tallySimulation } from "../domain/simulation";
import type { Eval, EvalResult, EvalToolAnswer, EvalVerdict } from "../domain/types";
import { differIndex, type TestStep } from "../test-view";
import { simulationLineText, simulationTable } from "../view";

const AT = new Date("2026-11-08T09:10:00Z");
const STAND_IN: EvalToolAnswer = {
  tool: "pick_seat",
  source: "stand-in",
  reason: "stand_in_model",
  ms: 10,
};
const verdict = (kind: EvalVerdict["kind"], status: EvalVerdict["status"]): EvalVerdict => ({
  kind,
  status,
  measured: null,
  limit: null,
  detail: "",
});
const side = (
  evalId: string,
  which: "before" | "after",
  passed: boolean | null,
  verdicts: EvalVerdict[],
  toolAnswers: EvalToolAnswer[] = [],
): EvalResult => ({
  id: `${evalId}-${which}`,
  projectId: "p",
  runId: "r",
  evalId,
  side: which,
  passed,
  verdicts,
  change: null,
  durationMs: null,
  costUsd: null,
  toolCalls: null,
  toolAnswers,
  transcript: null,
  error: passed === null ? "The recorded run is gone." : null,
  createdAt: AT,
});
const evalOf = (id: string, name: string, tasks: string[]): Eval => ({
  id,
  projectId: "p",
  name,
  sourceTurnId: null,
  sourceCaseId: null,
  message: "",
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
  createdAt: AT,
  updatedAt: AT,
});
const row = (
  evalId: string,
  before: EvalResult | null,
  after: EvalResult | null,
  outcome: SimulationRow["outcome"],
): SimulationRow => ({ evalId, before, after, outcome });

const ROWS: SimulationRow[] = [
  row(
    "e1",
    side("e1", "before", false, [verdict("ends_well", "pass"), verdict("max_tool_calls", "fail")]),
    side("e1", "after", true, [verdict("ends_well", "pass"), verdict("max_tool_calls", "pass")]),
    "fixed",
  ),
  row(
    "e2",
    side("e2", "before", true, [verdict("expected_tool", "pass")]),
    side("e2", "after", false, [verdict("expected_tool", "fail")]),
    "broke",
  ),
  row(
    "e3",
    side("e3", "before", false, [verdict("max_tool_calls", "fail")]),
    side("e3", "after", true, [verdict("max_tool_calls", "pass")], [STAND_IN]),
    "unverified",
  ),
  row("e4", side("e4", "before", true, [verdict("ends_well", "pass")]), null, "same"),
  row("e5", side("e5", "before", null, []), null, null),
];
const EVALS = [
  evalOf("e1", "Flight cancelled", ["wf-1"]),
  evalOf("e2", "Booking not found", ["wf-2"]),
  evalOf("e3", "Split booking", ["wf-1"]),
  evalOf("e4", "Refund status", ["wf-3"]),
  evalOf("e5", "Gone", []),
];
const NAMES = new Map([["wf-1", "Rebook a disrupted flight"]]);

test("the simulation table shows the result with the fix (today's when untouched) and marks Fixed, Broke and Unverified against today", () => {
  const table = simulationTable(ROWS, EVALS, NAMES, "all");
  assert.deepEqual(table.columns, ["ends_well", "expected_tool", "max_tool_calls"]);
  const byId = new Map(table.rows.map((r) => [r.evalId, r]));
  assert.deepEqual(byId.get("e1")!.cells, {
    ends_well: "pass",
    max_tool_calls: "pass",
    expected_tool: "dot",
  });
  assert.deepEqual(
    [byId.get("e1")!.change, byId.get("e1")!.outlined, byId.get("e1")!.passed],
    ["fixed", true, true],
  );
  assert.deepEqual(
    [byId.get("e2")!.change, byId.get("e2")!.outlined, byId.get("e2")!.passed],
    ["broke", true, false],
  );
  assert.deepEqual([byId.get("e3")!.change, byId.get("e3")!.outlined], ["unverified", true]);
  assert.deepEqual(
    [byId.get("e4")!.change, byId.get("e4")!.outlined, byId.get("e4")!.cells.ends_well],
    ["same", false, "pass"],
  );
  assert.equal(byId.get("e5")!.error, "The recorded run is gone.");
  assert.deepEqual(byId.get("e1")!.tasks, [{ id: "wf-1", label: "Rebook a disrupted flight" }]);
  assert.deepEqual(table.counts, { all: 5, failing: 2, changed: 3 });
  assert.deepEqual(
    simulationTable(ROWS, EVALS, NAMES, "changed")
      .rows.map((r) => r.evalId)
      .sort(),
    ["e1", "e2", "e3"],
  );
});

test("a simulation's line: pass count with the fix, today's, and what changed; an unverified pass is not counted as fixed", () => {
  const tally = tallySimulation(ROWS);
  assert.deepEqual(tally, { total: 5, passed: 3, today: 2, fixed: 1, broke: 1, unverified: 1 });
  assert.deepEqual(simulationLineText(tally), {
    pass: "3/5",
    today: "today 2",
    change: "1 fixed · 1 broke · 1 unverified",
  });
  assert.deepEqual(
    simulationLineText({ total: 2, passed: 2, today: 2, fixed: 0, broke: 0, unverified: 0 }).change,
    "No change",
  );
});

test("Run again repeats the suite its label names; an added list repeats its evals", () => {
  assert.deepEqual(suiteOfRun("Related tasks", ["e1"]), { kind: "related" });
  assert.deepEqual(suiteOfRun("All evals", ["e1"]), { kind: "all" });
  assert.deepEqual(suiteOfRun("Failing today", ["e1"]), { kind: "failing" });
  assert.deepEqual(suiteOfRun("Task wf-1", ["e1"]), { kind: "task", workflowId: "wf-1" });
  assert.deepEqual(suiteOfRun("Added evals", ["e1", "e2"]), {
    kind: "list",
    evalIds: ["e1", "e2"],
  });
});

test("the runs differ from the first step that is not the same on both sides; identical runs have no such line", () => {
  const tool = (name: string): TestStep => ({
    kind: "tool",
    tool: name,
    source: "recorded",
    rule: "",
    reason: "",
    ms: null,
    args: null,
    result: null,
    isError: false,
  });
  const reply = (text: string): TestStep => ({ kind: "reply", text });
  assert.equal(
    differIndex([tool("find_booking"), reply("Found")], [tool("rebook_and_notify"), reply("Done")]),
    0,
  );
  assert.equal(
    differIndex(
      [tool("find_booking"), tool("send_message")],
      [tool("find_booking"), tool("notify")],
    ),
    1,
  );
  assert.equal(differIndex([tool("a"), reply("x")], [tool("a"), reply("x")]), null);
  assert.equal(differIndex([tool("a")], [tool("a"), reply("x")]), 1);
});
