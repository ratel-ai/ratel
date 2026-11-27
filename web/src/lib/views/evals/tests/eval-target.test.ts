import assert from "node:assert/strict";
import { test } from "node:test";
import type { EvalDefinition } from "../domain/eval";
import { defaultTask, saveTarget, scorersOfTask } from "../domain/eval-target";
import { evalContent, NO_REFUND, PROJECT_ID } from "./support";

const REFUNDS = { id: "wf-refunds", name: "Refund an order" };
const STATUS = { id: "wf-status", name: "Track an order" };
const DEFAULTS = { scorers: [NO_REFUND], sandboxName: "support-demo" };

function definition(id: string, name: string, taskId: string | null): EvalDefinition {
  return {
    id,
    projectId: PROJECT_ID,
    name,
    taskId,
    createdAt: new Date(0),
    versions: [
      {
        ...evalContent(),
        id: `${id}-v1`,
        evalId: id,
        number: 1,
        createdBy: "u",
        createdAt: new Date(0),
      },
    ],
  };
}

test("one task is the default", () => {
  assert.deepEqual(defaultTask([REFUNDS], null), REFUNDS);
  assert.deepEqual(defaultTask([REFUNDS], "wf-other"), REFUNDS);
});

test("with more tasks the task of the page is the default, else the person chooses", () => {
  assert.deepEqual(defaultTask([REFUNDS, STATUS], "wf-status"), STATUS);
  assert.equal(defaultTask([REFUNDS, STATUS], null), null);
  assert.equal(defaultTask([REFUNDS, STATUS], "wf-other"), null);
});

test("with no task there is no default", () => {
  assert.equal(defaultTask([], "wf-status"), null);
});

test("a task with an eval saves into that eval", () => {
  const evals = [definition("e1", "Status", STATUS.id), definition("e2", "Refunds", REFUNDS.id)];
  assert.deepEqual(saveTarget(REFUNDS, evals, DEFAULTS), {
    kind: "existing",
    evalId: "e2",
    name: "Refunds",
    taskId: REFUNDS.id,
  });
});

test("a task with more evals has no default eval: the person chooses one", () => {
  const evals = [
    definition("e1", "Refunds", REFUNDS.id),
    definition("e2", "Status", STATUS.id),
    definition("e3", "Refunds, hard", REFUNDS.id),
  ];
  assert.deepEqual(saveTarget(REFUNDS, evals, DEFAULTS), {
    kind: "choose",
    taskId: REFUNDS.id,
    evals: [
      { id: "e1", name: "Refunds" },
      { id: "e3", name: "Refunds, hard" },
    ],
  });
});

test("a task with no eval gets a new eval with the task's default scorers and the last sandbox", () => {
  const evals = [definition("e1", "Refund an order", null)];
  assert.deepEqual(saveTarget(REFUNDS, evals, DEFAULTS), {
    kind: "new",
    // The name of the task is taken: the new eval gets a number.
    name: "Refund an order 2",
    taskId: REFUNDS.id,
    content: { sandboxName: "support-demo", params: {}, trials: 3, scorers: [NO_REFUND] },
  });
});

test("a turn with no task goes to an eval that the person names", () => {
  assert.deepEqual(saveTarget(null, [], DEFAULTS), { kind: "named" });
});

test("the default scorers of a task become checks and judges of the eval", () => {
  const scorers = scorersOfTask([
    { kind: "expected_tool", tool: "refund_order" },
    { kind: "max_latency_ms", max: 8000 },
    { kind: "max_cost_usd", max: 0.05 },
    { kind: "judge_criteria", criteria: "Does it confirm the refund?" },
    // A trial has no measure of these: they are left out.
    { kind: "ends_well" },
    { kind: "max_self_corrections", max: 1 },
    { kind: "max_tool_calls", max: 6 },
  ]);
  assert.deepEqual(
    scorers.map(({ name, gating, definition }) => [name, gating, definition]),
    [
      [
        "Calls refund_order",
        true,
        { kind: "check", config: { path: "tools", op: "contains", value: "refund_order" } },
      ],
      [
        "At most 8000 ms",
        true,
        { kind: "check", config: { path: "duration_ms", op: "lte", value: 8000 } },
      ],
      [
        "At most $0.05",
        true,
        { kind: "check", config: { path: "cost_usd", op: "lte", value: 0.05 } },
      ],
      [
        "Does it confirm the refund?",
        true,
        { kind: "judge", config: { prompt: "Does it confirm the refund?", output: "boolean" } },
      ],
    ],
  );
  assert.equal(new Set(scorers.map(({ id }) => id)).size, 4);
});
