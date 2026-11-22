import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareSides,
  parseSimulationSuite,
  type SuiteContext,
  selectSuite,
  tallySimulation,
} from "../domain/simulation";
import type { EvalToolAnswer } from "../domain/types";

const CONTEXT: SuiteContext = {
  evals: [
    { id: "e1", tasks: ["wf-1"] },
    { id: "e2", tasks: ["wf-1", "wf-2"] },
    { id: "e3", tasks: ["wf-3"] },
    { id: "e4", tasks: [] },
  ],
  fixTasks: ["wf-2", "wf-1"],
  failingToday: new Set(["e3", "e4"]),
};

const RECORDED: EvalToolAnswer = {
  tool: "get_seat_map",
  source: "recorded",
  reason: "matched_recording",
  ms: 10,
};
const STAND_IN: EvalToolAnswer = {
  tool: "select_seat",
  source: "stand-in",
  reason: "stand_in_model",
  ms: 10,
};

test("related tasks (the default) are the evals linked to any task of the fix", () => {
  assert.deepEqual(selectSuite({ kind: "related" }, CONTEXT), {
    evalIds: ["e1", "e2"],
    label: "Related tasks",
  });
});

test("all is every eval, failing today is those that failed in the latest manual or nightly run", () => {
  assert.deepEqual(selectSuite({ kind: "all" }, CONTEXT), {
    evalIds: ["e1", "e2", "e3", "e4"],
    label: "All evals",
  });
  assert.deepEqual(selectSuite({ kind: "failing" }, CONTEXT), {
    evalIds: ["e3", "e4"],
    label: "Failing today",
  });
});

test("one task is that task's evals, and a list keeps only evals of the set, in set order", () => {
  assert.deepEqual(selectSuite({ kind: "task", workflowId: "wf-3" }, CONTEXT), {
    evalIds: ["e3"],
    label: "Task wf-3",
  });
  assert.deepEqual(selectSuite({ kind: "list", evalIds: ["e4", "gone", "e1", "e4"] }, CONTEXT), {
    evalIds: ["e1", "e4"],
    label: "Added evals",
  });
});

test("a fix with no tasks has no related evals", () => {
  assert.deepEqual(selectSuite({ kind: "related" }, { ...CONTEXT, fixTasks: [] }).evalIds, []);
});

test("a suite parses from the action's input and refuses what it does not know", () => {
  assert.deepEqual(parseSimulationSuite(undefined), { kind: "related" });
  assert.deepEqual(parseSimulationSuite({ kind: "failing" }), { kind: "failing" });
  assert.deepEqual(parseSimulationSuite({ kind: "task", workflowId: "wf-1" }), {
    kind: "task",
    workflowId: "wf-1",
  });
  assert.deepEqual(parseSimulationSuite({ kind: "list", evalIds: ["a", 3, "b"] }), {
    kind: "list",
    evalIds: ["a", "b"],
  });
  assert.equal(parseSimulationSuite({ kind: "task" }), null);
  assert.equal(parseSimulationSuite({ kind: "list", evalIds: [] }), null);
  assert.equal(parseSimulationSuite({ kind: "nope" }), null);
});

test("fails today and passes with the fix: fixed; passes today and fails with the fix: broke", () => {
  assert.equal(
    compareSides(
      { passed: false, toolAnswers: [RECORDED] },
      { passed: true, toolAnswers: [RECORDED] },
    ),
    "fixed",
  );
  assert.equal(
    compareSides(
      { passed: true, toolAnswers: [RECORDED] },
      { passed: false, toolAnswers: [RECORDED] },
    ),
    "broke",
  );
});

test("the same verdict on both sides is same, and so is an eval the fix does not touch (no after side)", () => {
  assert.equal(
    compareSides({ passed: true, toolAnswers: [] }, { passed: true, toolAnswers: [STAND_IN] }),
    "same",
  );
  assert.equal(
    compareSides({ passed: false, toolAnswers: [] }, { passed: false, toolAnswers: [] }),
    "same",
  );
  assert.equal(compareSides({ passed: true, toolAnswers: [] }, null), "same");
});

test("Q5: a pass with the fix that rests on a stand-in answer is unverified, not fixed", () => {
  assert.equal(
    compareSides(
      { passed: false, toolAnswers: [RECORDED] },
      { passed: true, toolAnswers: [RECORDED, STAND_IN] },
    ),
    "unverified",
  );
});

test("RC-609: a pass with the fix that rests on a model-written input is unverified, not fixed", () => {
  assert.equal(
    compareSides(
      { passed: false, toolAnswers: [RECORDED] },
      { passed: true, toolAnswers: [RECORDED], generated: ["systemPrompt"] },
    ),
    "unverified",
  );
  assert.equal(
    compareSides(
      { passed: false, toolAnswers: [RECORDED] },
      { passed: true, toolAnswers: [RECORDED], generated: [] },
    ),
    "fixed",
  );
});

test("a side with no verdict gives no outcome", () => {
  assert.equal(
    compareSides({ passed: null, toolAnswers: [] }, { passed: true, toolAnswers: [] }),
    null,
  );
  assert.equal(
    compareSides({ passed: false, toolAnswers: [] }, { passed: null, toolAnswers: [] }),
    null,
  );
  assert.equal(compareSides(null, null), null);
});

test("a simulation's line counts passes with the fix (today's verdict when untouched), passes today, fixed, broke and unverified", () => {
  const tally = tallySimulation([
    { before: { passed: false, toolAnswers: [] }, after: { passed: true, toolAnswers: [] } },
    { before: { passed: true, toolAnswers: [] }, after: { passed: false, toolAnswers: [] } },
    {
      before: { passed: false, toolAnswers: [] },
      after: { passed: true, toolAnswers: [STAND_IN] },
    },
    { before: { passed: true, toolAnswers: [] }, after: null },
    { before: { passed: null, toolAnswers: [] }, after: null },
  ]);
  assert.deepEqual(tally, { total: 5, passed: 3, today: 2, fixed: 1, broke: 1, unverified: 1 });
});
