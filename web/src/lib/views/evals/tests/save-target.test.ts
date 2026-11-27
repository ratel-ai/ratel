import assert from "node:assert/strict";
import { test } from "node:test";
import type { EvalDefinition } from "../domain/eval";
import { chosenTargets, type SaveOptions, saveOptions, targetDataset } from "../save-target";
import { evalContent, PROJECT_ID } from "./support";

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
  });
  assert.equal(options.defaultTaskId, "sandbox:support-demo");
  const target = options.targets["sandbox:support-demo"];
  assert.equal(target?.kind, "new");
  assert.equal(target?.kind === "new" ? target.name : null, "support-demo");
  assert.equal(target?.kind === "new" ? target.content.sandboxName : null, "support-demo");
});

test("the dialog names the dataset that each eval saves into", async () => {
  const refunds: EvalDefinition = {
    id: "e1",
    projectId: PROJECT_ID,
    name: "Refunds",
    taskId: null,
    createdAt: new Date(0),
    versions: [
      {
        ...evalContent(),
        datasetId: "d1",
        id: "v1",
        evalId: "e1",
        number: 1,
        createdBy: "u",
        createdAt: new Date(0),
      },
    ],
  };
  const options = await saveOptions(PROJECT_ID, null, null, {
    taskLinks: {
      tasksOfTurn: async () => [],
      tasksOfTrace: async () => [],
      defaultScorers: async () => [],
      lastSandbox: async () => null,
    },
    evals: { list: async () => [refunds] },
    datasets: { list: async () => [{ id: "d1", name: "Refund asks" } as never] },
  });
  assert.deepEqual(options.datasetOfEval, { e1: "Refund asks" });
  assert.equal(targetDataset(options, "e1"), "Refund asks");
  assert.equal(targetDataset(options, "e9"), null);
});
