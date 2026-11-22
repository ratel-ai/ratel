import assert from "node:assert/strict";
import { test } from "node:test";
import {
  suiteText,
  taskDisplayName,
  taskOfSuite,
  taskTag,
  UNTITLED_TASK,
} from "../domain/task-name";

const ID = "wf-7f3a9c01";

test("a task reads as its label", () => {
  assert.equal(taskDisplayName("Refund status", ["Where is my refund?"]), "Refund status");
  assert.equal(taskDisplayName("  Rebook a flight ", []), "Rebook a flight");
});

test("a task without a label reads as Untitled task and the first words of its most common ask, never its id", () => {
  const asks = [
    "Move me to an aisle seat please on flight R1",
    "Where is my refund?",
    "Move me  to an aisle seat please on flight R1",
  ];
  assert.equal(taskDisplayName(null, asks), 'Untitled task · "Move me to an aisle seat…"');
  assert.equal(taskDisplayName("", ["Cancel it"]), 'Untitled task · "Cancel it"');
  assert.equal(taskDisplayName(undefined, []), UNTITLED_TASK);
  assert.equal(taskDisplayName(undefined, ["   "]), UNTITLED_TASK);
});

test("a tag the names miss, and a task suite, never show the id", () => {
  assert.deepEqual(taskTag(ID, new Map()), { id: ID, label: UNTITLED_TASK });
  assert.deepEqual(taskTag(ID, new Map([[ID, "Refund status"]])), {
    id: ID,
    label: "Refund status",
  });
  assert.equal(taskOfSuite(`Task ${ID}`), ID);
  assert.equal(taskOfSuite("All evals"), null);
  assert.equal(suiteText(`Task ${ID}`, new Map([[ID, "Refund status"]])), "Task: Refund status");
  assert.equal(suiteText(`Task ${ID}`, new Map()), `Task: ${UNTITLED_TASK}`);
  assert.equal(suiteText("Related tasks", new Map()), "Related tasks");
  assert.doesNotMatch(suiteText(`Task ${ID}`, new Map()), new RegExp(ID));
});
