import assert from "node:assert/strict";
import { test } from "node:test";
import {
  foldCalls,
  TASK_QUESTION,
  taskContent,
  taskVerdictOf,
} from "@/lib/readings/trace-signals/outcomes/task-question";
import {
  segmentTasks,
  type TaskTurn,
  taskOutcome,
  tierOf,
} from "@/lib/readings/trace-signals/outcomes/tasks";

let n = 0;
function turn(over: Partial<TaskTurn> = {}): TaskTurn {
  n += 1;
  return {
    turnId: `t-${String(n).padStart(3, "0")}`,
    startedAt: new Date(Date.parse("2026-09-01T09:00:00Z") + n * 60_000),
    endedAt: new Date(Date.parse("2026-09-01T09:00:30Z") + n * 60_000),
    okCalls: 1,
    failedCalls: 0,
    streaks: 0,
    unmetSearches: 0,
    ...over,
  };
}

test("a request starts a task, a message that is not one joins the task before it, and without words every turn is its own task", () => {
  const ask = turn({ request: true });
  const fix = turn({ request: false });
  const thanks = turn({ request: false, okCalls: 0 });
  const next = turn({ request: true });
  const tasks = segmentTasks([next, thanks, ask, fix]);
  assert.deepEqual(
    tasks.map((t) => [t.taskId, t.turnIds, t.goalSource]),
    [
      [ask.turnId, [ask.turnId, fix.turnId, thanks.turnId], "request"],
      [next.turnId, [next.turnId], "request"],
    ],
  );

  const searched = turn({ request: null, searches: 2 });
  const direct = turn({ request: null, searches: 0 });
  // A turn that only searched is no task; one whose search no tool fits is.
  const only = turn({ request: null, searches: 1, okCalls: 0 });
  const unfit = turn({ request: null, searches: 1, okCalls: 0, unmetSearches: 1 });
  assert.deepEqual(
    segmentTasks([searched, direct, only, unfit]).map((t) => [t.taskId, t.goalSource]),
    [
      [searched.turnId, "search"],
      [direct.turnId, "none"],
      [unfit.turnId, "search"],
    ],
  );
});

test("the tier says how much a task could be read from", () => {
  assert.equal(tierOf("none", [turn()]), "t0");
  assert.equal(tierOf("search", [turn()]), "t1");
  assert.equal(tierOf("request", [turn()]), "t2");
  assert.equal(tierOf("request", [turn(), turn({ satisfaction: "satisfied" })]), "t3");
});

test("the person walking away decides first: escalated on any turn, gave up or took over on the last", () => {
  const request = { goalSource: "request" as const };
  assert.equal(
    taskOutcome(
      request,
      [turn({ reaction: "asks_human" }), turn({ satisfaction: "satisfied" })],
      null,
    ).reason,
    "escalated",
  );
  assert.deepEqual(
    [
      taskOutcome(request, [turn({ reaction: "gives_up" })], null).reason,
      taskOutcome(request, [turn({ reaction: "takes_over" })], null).reason,
    ],
    ["gave_up", "took_over"],
  );
  // Even a model saying the goal was achieved does not outrank the person.
  const over = taskOutcome(request, [turn({ reaction: "gives_up" })], {
    answer: "achieved",
    probability: 0.99,
  });
  assert.deepEqual([over.result, over.reason, over.source], ["not_completed", "gave_up", "model"]);
});

test("a correct refusal, a last turn with nothing working, and a last turn that failed or went wrong are not completed, each with its reason", () => {
  const goal = { goalSource: "request" as const };
  assert.deepEqual(
    pick(
      taskOutcome(goal, [turn({ result: "refused", cause: "correct_refusal", okCalls: 0 })], null),
    ),
    ["not_completed", "refused", "correct_refusal"],
  );
  assert.deepEqual(
    pick(
      taskOutcome(
        goal,
        [turn({ okCalls: 0, failedCalls: 2, streaks: 1, cause: "bad_arguments" })],
        null,
      ),
    ),
    ["not_completed", "failed_call", "bad_arguments"],
  );
  assert.deepEqual(pick(taskOutcome(goal, [turn({ okCalls: 0, unmetSearches: 1 })], null)), [
    "not_completed",
    "no_tool",
    "missing_capability",
  ]);
  assert.deepEqual(
    pick(
      taskOutcome(
        goal,
        [turn({ result: "completed_wrong", resultSource: "model", cause: "misread_request" })],
        null,
      ),
    ),
    ["not_completed", "wrong_action", "misread_request"],
  );
  assert.deepEqual(
    pick(
      taskOutcome(
        goal,
        [turn({ result: "completed_wrong", resultSource: "model", cause: "incomplete" })],
        null,
      ),
    ),
    ["not_completed", "did_part", "incomplete"],
  );
  assert.deepEqual(pick(taskOutcome(goal, [turn({ satisfaction: "unsatisfied" })], null)), [
    "not_completed",
    "unsatisfied",
    null,
  ]);
  // A changed mind is not an objection.
  assert.equal(
    taskOutcome(goal, [turn({ satisfaction: "unsatisfied", reaction: "new_request" })], null)
      .result,
    "completed",
  );
});

test("the task question decides when the trace and the person say nothing against it; unsure reads as can't tell", () => {
  const search = { goalSource: "search" as const };
  const ok = [turn({ okCalls: 3 })];
  assert.deepEqual(pick(taskOutcome(search, ok, { answer: "not_achieved", probability: 0.92 })), [
    "not_completed",
    "goal_missed",
    null,
  ]);
  assert.deepEqual(pick(taskOutcome(search, ok, { answer: "partly", probability: 0.9 })), [
    "not_completed",
    "did_part",
    "incomplete",
  ]);
  assert.equal(
    taskOutcome(search, ok, { answer: "not_achieved", probability: 0.6 }).result,
    "unknown",
  );
  assert.equal(
    taskOutcome(search, ok, { answer: "cant_tell", probability: 0.95 }).result,
    "unknown",
  );
  const achieved = taskOutcome(search, ok, { answer: "achieved", probability: 0.95 });
  assert.deepEqual(
    [achieved.result, achieved.checked, achieved.tier, achieved.source],
    ["completed", true, "t1", "model"],
  );
});

test("completed after friction when something failed or was objected to on the way; unchecked when nothing read the goal", () => {
  const goal = { goalSource: "request" as const };
  const friction = taskOutcome(
    goal,
    [turn({ streaks: 1, failedCalls: 1 }), turn({ satisfaction: "satisfied" })],
    null,
  );
  assert.deepEqual([friction.result, friction.checked], ["completed_after_friction", true]);
  const corrected = taskOutcome(
    goal,
    [
      turn({ reaction: "corrects", result: "completed_wrong", resultSource: "model" }),
      turn({ reaction: "satisfied", satisfaction: "satisfied" }),
    ],
    null,
  );
  assert.equal(corrected.result, "completed_after_friction");

  const traceOnly = taskOutcome({ goalSource: "none" }, [turn({ okCalls: 4 })], null);
  assert.deepEqual(
    [traceOnly.result, traceOnly.checked, traceOnly.tier, traceOnly.source],
    ["completed", false, "t0", "rule"],
  );
  assert.equal(
    taskOutcome({ goalSource: "none" }, [turn({ okCalls: 0 })], null).result,
    "unknown",
    "nothing worked and nothing failed",
  );
});

test("a task completed after friction says what got in the way, the most telling first", () => {
  const goal = { goalSource: "request" as const };
  const of = (turns: TaskTurn[]) => {
    const outcome = taskOutcome(goal, turns, null);
    return [outcome.result, outcome.reason, outcome.cause];
  };
  assert.deepEqual(
    of([
      turn({ streaks: 1, failedCalls: 1, cause: "bad_arguments" }),
      turn({ reaction: "corrects", satisfaction: "unsatisfied", cause: "misread_request" }),
      turn({ satisfaction: "satisfied" }),
    ]),
    ["completed_after_friction", "corrected", "misread_request"],
    "a correction outranks a failed call before it",
  );
  assert.deepEqual(of([turn({ reaction: "repeats" }), turn({ satisfaction: "satisfied" })]), [
    "completed_after_friction",
    "repeated",
    null,
  ]);
  assert.deepEqual(of([turn({ streaks: 1, failedCalls: 1, cause: "tool_fault" }), turn()]), [
    "completed_after_friction",
    "recovered_call",
    "tool_fault",
  ]);
  // Searching again is not friction.
  assert.deepEqual(of([turn({ unmetSearches: 1, okCalls: 0 }), turn()]), ["completed", null, null]);
  assert.deepEqual(of([turn(), turn({ satisfaction: "satisfied" })]), ["completed", null, null]);
});

test("the task question's content: the goal, every exchange with repeated calls folded, and what the person said after", () => {
  assert.equal(foldCalls([]), "nothing");
  assert.equal(
    foldCalls([
      { tool: "update_task", outcome: "ok" },
      { tool: "update_task", outcome: "ok" },
      { tool: "update_task", outcome: "error", error: "validation_failed" },
      { tool: "add_task_comment", outcome: "ok" },
    ]),
    "update_task (ok) ×2; update_task (error: validation_failed); add_task_comment (ok)",
  );
  const content = taskContent({
    taskId: "t1",
    goal: { source: "request", text: "set the due date of all sprint 14 tasks to Friday" },
    exchanges: [
      {
        message: null,
        calls: [
          { tool: "filter_tasks", outcome: "ok" },
          { tool: "update_task", outcome: "ok" },
          { tool: "update_task", outcome: "ok" },
        ],
        reply: null,
      },
      {
        message: "only 2 changed, there are 9",
        calls: Array.from({ length: 7 }, () => ({ tool: "update_task", outcome: "ok" as const })),
        reply: null,
      },
    ],
    next: "now they're all Friday, thanks",
  });
  assert.equal(
    content,
    [
      "Goal, as the person asked: set the due date of all sprint 14 tasks to Friday",
      "The agent did: filter_tasks (ok); update_task (ok) ×2",
      "The person then said: only 2 changed, there are 9",
      "The agent did: update_task (ok) ×7",
      "After that the person said: now they're all Friday, thanks",
    ].join("\n"),
  );
  const searched = taskContent({
    taskId: "t2",
    goal: { source: "search", queries: ["update task status to done"] },
    exchanges: [
      { message: null, calls: [{ tool: "add_task_comment", outcome: "ok" }], reply: null },
    ],
    next: null,
  });
  assert.equal(
    searched,
    "Goal, as the agent searched its tools for it:\n1. update task status to done\nThe agent did: add_task_comment (ok)",
  );
  assert.deepEqual(
    TASK_QUESTION.options?.map((o) => o.option),
    ["achieved", "partly", "not_achieved", "cant_tell"],
  );
});

test("a stored answer reads back as a task verdict; an abstention as unknown", () => {
  assert.deepEqual(taskVerdictOf({ answer: "partly", probability: 0.91 }), {
    answer: "partly",
    probability: 0.91,
  });
  assert.deepEqual(taskVerdictOf({ answer: "unknown", probability: null }), {
    answer: "unknown",
    probability: null,
  });
  assert.equal(taskVerdictOf(undefined), null);
});

function pick(outcome: ReturnType<typeof taskOutcome>): [string, string | null, string | null] {
  return [outcome.result, outcome.reason, outcome.cause];
}
