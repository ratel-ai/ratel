import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chosenDataset,
  chosenTargets,
  type SaveOptions,
  saveOptions,
  targetDataset,
} from "../save-target";
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
  datasets: [{ id: "d1", name: "Order asks" }],
  datasetOfEval: { e1: "Refunds", e2: "Refunds, hard", e3: "Status rows" },
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

test("with no task, the dataset that the person chose or named (decision trace-to-eval)", () => {
  const none = { ...OPTIONS, tasks: [], targets: {} };
  assert.equal(chosenTargets(none, { taskIds: [], evalOfTask: {} }), null);
  assert.deepEqual(chosenDataset(none, { datasetId: "d1" }), {
    datasetId: "d1",
    name: "Order asks",
  });
  assert.deepEqual(chosenDataset(none, { newName: " Smoke " }), { newName: "Smoke" });
  assert.equal(chosenDataset(none, { newName: " " }), null);
  assert.equal(chosenDataset(none, { datasetId: "gone" }), null);
});

test("each target says the dataset that the row goes into", () => {
  assert.equal(targetDataset(OPTIONS, OPTIONS.targets["wf-status"], undefined), "Status rows");
  assert.equal(targetDataset(OPTIONS, OPTIONS.targets["wf-refunds"], "e2"), "Refunds, hard");
  assert.equal(targetDataset(OPTIONS, OPTIONS.targets["wf-refunds"], undefined), null);
  // A new eval gets a new fixed dataset with its name.
  assert.equal(targetDataset(OPTIONS, OPTIONS.targets["wf-new"], undefined), "Cancel an order");
});

test("a run of a Ratel sandbox saves into a new eval of the task of its sandbox, on that sandbox", async () => {
  const options = await saveOptions("p1", { traceId: "abc" }, null, {
    taskLinks: {
      tasksOfTurn: async () => [],
      tasksOfTrace: async () => [{ id: "sandbox:support-demo", name: "support-demo" }],
      defaultScorers: async () => [],
      // The newest ready version is of another sandbox of the project.
      lastSandbox: async () => "command-demo",
    },
    evals: { list: async () => [] },
    datasets: { list: async () => [] },
  });
  assert.equal(options.defaultTaskId, "sandbox:support-demo");
  const target = options.targets["sandbox:support-demo"];
  assert.equal(target?.kind, "new");
  assert.equal(target?.kind === "new" ? target.name : null, "support-demo");
  assert.equal(target?.kind === "new" ? target.content.sandboxName : null, "support-demo");
});
