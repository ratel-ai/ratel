import assert from "node:assert/strict";
import { test } from "node:test";
import { extractFrames, MAX_FRAMES } from "@/lib/readings/intent-engine/frames";
import { VerbLexicon } from "@/lib/readings/intent-engine/text";

function lexicon(tools: string[]): VerbLexicon {
  const v = new VerbLexicon();
  for (const t of tools) v.learnTool(t);
  return v;
}

const TASKS = lexicon([
  "acme__create_task",
  "acme__add_task_comment",
  "acme__list_tasks",
  "acme__update_task",
  "acme__search_tasks",
]);
/** Another domain entirely, so the rules hold beyond one catalog. */
const SHOP = lexicon([
  "orders__cancel_order",
  "payments__refund_payment",
  "invoices__send_invoice",
  "tickets__escalate_ticket",
]);

const read = (text: string, v: VerbLexicon) =>
  extractFrames(text, v).map((f) => ({ text: f.text, action: f.action, synthetic: f.synthetic }));

test("an ask with one action is one frame, unchanged", () => {
  for (const text of [
    "create task",
    "search tasks by text",
    "update status and description",
    "fix the CI tests",
    "I want to create a task for the bug",
  ]) {
    const frames = extractFrames(text, TASKS);
    assert.equal(frames.length, 1, text);
    assert.equal(frames[0].text, text, "a single frame keeps the ask's own text");
    assert.equal(frames[0].synthetic, false);
  }
});

test("an agent's run-on search splits at every action head", () => {
  assert.deepEqual(read("create task comment on task list tasks in project", TASKS), [
    { text: "create task", action: "create", synthetic: false },
    { text: "comment on task", action: TASKS.leadVerb("comment"), synthetic: false },
    { text: "list tasks in project", action: "list", synthetic: false },
  ]);
  assert.deepEqual(
    read("list project tasks search tasks update task status complete", TASKS).map((f) => f.text),
    ["list project tasks", "search tasks", "update task status complete"],
  );
});

test("coordinated requests split, and a later one borrows the object it points back to", () => {
  assert.deepEqual(read("check the CI tests and fix the failed ones", TASKS), [
    { text: "check the CI tests", action: "check", synthetic: false },
    { text: "fix the failed CI tests", action: "fix", synthetic: true },
  ]);
  assert.deepEqual(read("list tasks and then sync", TASKS)[1], {
    text: "sync tasks",
    action: "sync",
    synthetic: true,
  });
});

test("a verb read as a noun starts no frame", () => {
  for (const text of [
    "add comment on task", // right after its verb
    "delete or remove a link", // an alternative verb
    "Add a progress comment to an existing task", // the catalog's add acts on comments
    "post progress comment", // the last word of the phrase
    "create a markdown document linked to an existing project", // a participle
    "filter tasks by update", // after a preposition
    "move the task to review", // after "to" with an object already
  ]) {
    assert.equal(extractFrames(text, TASKS).length, 1, text);
  }
});

test("an ask with no action has one frame with no head", () => {
  const [frame] = extractFrames("give new task id for it", TASKS);
  assert.equal(frame.head, "none");
  assert.equal(frame.action, null);
  assert.equal(frame.object, "task");
  assert.equal(extractFrames("the tests are failing", TASKS)[0].head, "none");
});

test("tool ids written into an ask are action heads", () => {
  const frames = extractFrames("use acme__create_task then acme__add_task_comment", TASKS);
  assert.deepEqual(
    frames.map((f) => [f.head, f.action, f.object]),
    [
      ["tool_id", "create", "task"],
      ["tool_id", "add", "task"],
    ],
  );
});

test("the same rules read another domain", () => {
  assert.deepEqual(
    read("cancel the order and refund the customer", SHOP).map((f) => f.action),
    ["cancel", "refund"],
  );
  assert.deepEqual(
    read("escalate the ticket, send the invoice then close it", SHOP).map((f) => [
      f.text,
      f.synthetic,
    ]),
    [
      ["escalate the ticket", false],
      ["send the invoice", false],
      ["close invoice", true],
    ],
  );
});

test("values become slots, and no ask yields more than the cap", () => {
  const [frame] = extractFrames("assign task RC-208 to bob@example.com", TASKS);
  assert.deepEqual(frame.slots, ["id", "email"], "in order of appearance");
  const many = extractFrames(
    "create task list tasks update task search tasks sync tasks archive tasks",
    TASKS,
  );
  assert.equal(many.length, MAX_FRAMES);
  assert.match(many[MAX_FRAMES - 1].text, /archive/, "the rest stay with the last frame");
});
