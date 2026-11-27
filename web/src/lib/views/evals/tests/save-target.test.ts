import assert from "node:assert/strict";
import { test } from "node:test";
import { chosenTargets, type SaveOptions } from "../save-target";
import { evalContent } from "./support";

const OPTIONS: SaveOptions = {
  tasks: [
    { id: "wf-refunds", name: "Refund an order" },
    { id: "wf-status", name: "Track an order" },
    { id: "wf-new", name: "Cancel an order" },
  ],
  defaultTaskId: null,
  targets: {
    "wf-refunds": {
      kind: "choose",
      taskId: "wf-refunds",
      evals: [
        { id: "e1", name: "Refunds" },
        { id: "e2", name: "Refunds, hard" },
      ],
    },
    "wf-status": { kind: "existing", evalId: "e3", name: "Status", taskId: "wf-status" },
    "wf-new": { kind: "new", name: "Cancel an order", taskId: "wf-new", content: evalContent() },
  },
  evals: [],
};

test("a task with more evals needs the choice of one", () => {
  const chosen = { taskIds: ["wf-refunds"], evalOfTask: {} };
  assert.equal(chosenTargets(OPTIONS, chosen), null);
  assert.deepEqual(chosenTargets(OPTIONS, { ...chosen, evalOfTask: { "wf-refunds": "e2" } }), [
    { evalId: "e2" },
  ]);
});

test("each chosen task gives one target: its eval, or its new eval", () => {
  assert.deepEqual(chosenTargets(OPTIONS, { taskIds: ["wf-status", "wf-new"], evalOfTask: {} }), [
    { evalId: "e3" },
    { newEval: { name: "Cancel an order", taskId: "wf-new", content: evalContent() } },
  ]);
  assert.equal(chosenTargets(OPTIONS, { taskIds: [], evalOfTask: {} }), null);
});

test("with no task, the eval that the person chose or named", () => {
  const none = { ...OPTIONS, tasks: [], targets: {} };
  assert.deepEqual(chosenTargets(none, { taskIds: [], evalOfTask: {}, evalId: "e3" }), [
    { evalId: "e3" },
  ]);
  assert.deepEqual(chosenTargets(none, { taskIds: [], evalOfTask: {}, newName: " Smoke " }), [
    { newEval: { name: "Smoke", taskId: null } },
  ]);
  assert.equal(chosenTargets(none, { taskIds: [], evalOfTask: {}, newName: " " }), null);
});
