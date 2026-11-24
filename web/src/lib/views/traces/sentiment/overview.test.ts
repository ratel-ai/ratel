import assert from "node:assert/strict";
import { test } from "node:test";
import {
  avoidabilityOf,
  buildOverview,
  REASON_ROWS,
  ROW_EXAMPLES,
} from "@/lib/views/traces/sentiment/overview";
import type {
  Occurrence,
  PageAnswer,
  PageTask,
  PageTurn,
} from "@/lib/views/traces/sentiment/page-model";
import {
  NO_SENTIMENT_FILTERS,
  type SentimentFilters,
  type SentimentSort,
} from "@/lib/views/traces/sentiment/page-paths";

const NOW = new Date("2026-09-03T12:00:00Z");

let n = 0;
function task(over: Partial<PageTask> = {}): PageTask {
  n += 1;
  const id = `task-${n}`;
  return {
    taskId: id,
    sessionId: `s-${n}`,
    turnIds: [id],
    startedAt: new Date("2026-09-02T10:00:00Z"),
    endedAt: new Date("2026-09-02T10:01:00Z"),
    costUsd: null,
    tokens: null,
    friction: null,
    tier: "t2",
    goalSource: "request",
    result: "completed",
    reason: null,
    cause: null,
    checked: true,
    ...over,
  };
}

function hit(
  of: PageTask,
  cause: Occurrence["cause"],
  tool: string | null = null,
  source: Occurrence["source"] = "rule",
): Pick<Occurrence, "turn" | "cause" | "tool" | "source"> {
  return {
    turn: { turnId: of.turnIds[0]!, sessionId: of.sessionId } as PageTurn,
    cause,
    tool,
    source,
  };
}

function answer(of: PageTask, satisfied: boolean, over: Partial<PageAnswer> = {}): PageAnswer {
  return {
    turnId: of.turnIds[0]!,
    sessionId: of.sessionId,
    satisfied,
    endedAt: of.endedAt,
    ...over,
  };
}

function overview(
  tasks: PageTask[],
  over: {
    answers?: PageAnswer[];
    occurrences?: Pick<Occurrence, "turn" | "cause" | "tool" | "source">[];
    filters?: Partial<SentimentFilters>;
    sort?: SentimentSort;
    costKnown?: boolean;
  } = {},
) {
  return buildOverview({
    tasks,
    answers: over.answers ?? [],
    occurrences: over.occurrences ?? [],
    filters: { ...NO_SENTIMENT_FILTERS, ...over.filters },
    sort: over.sort ?? "impact",
    costKnown: over.costKnown ?? false,
    now: NOW,
    windowDays: 3,
  });
}

test("a completed task whose goal nothing read counts as completed, a task that can't be told is left out, and satisfaction is over the turns people said how it went", () => {
  const done = task();
  const unchecked = task({ checked: false });
  const friction = task({ result: "completed_after_friction", reason: "repeated" });
  const failed = task({ result: "not_completed", reason: "failed_call" });
  const unknown = task({ result: "unknown" });
  const page = overview([done, unchecked, friction, failed, unknown], {
    answers: [
      answer(done, true),
      answer(friction, true, { inferred: true }),
      answer(failed, false),
      answer(task(), true),
    ],
  });
  assert.deepEqual(
    [page.tasks, page.completed, page.notCompleted, page.completion],
    [4, 3, 1, 0.75],
  );
  // The answer whose turn is in no task in scope is left out.
  assert.deepEqual(page.satisfaction, { score: 2 / 3, answers: 3, satisfied: 2, inferred: 1 });
  assert.deepEqual(
    page.statuses.map((status) => [status.filter, status.tasks, status.score, status.answers]),
    [
      ["completed", 2, 1, 1],
      ["completed_after_friction", 1, 1, 1],
      ["not_completed", 1, 0, 1],
    ],
  );
});

test("each reason is a group, not completed first; its root causes count a task once, with the task's cost and time", () => {
  const minute = {
    startedAt: new Date("2026-09-02T10:00:00Z"),
    endedAt: new Date("2026-09-02T10:01:00Z"),
  };
  const a = task({ result: "not_completed", reason: "failed_call", costUsd: 0.5, ...minute });
  const b = task({ result: "not_completed", reason: "failed_call", costUsd: 0.25, ...minute });
  const quiet = task({ result: "not_completed", reason: "gave_up" });
  const bumpy = task({
    result: "completed_after_friction",
    reason: "recovered_call",
    costUsd: 2,
    friction: { extraTurns: 1, retriedCalls: 0, tokens: null, costUsd: 0.5, timeMs: 30_000 },
  });
  const page = overview([a, b, quiet, bumpy, task()], {
    occurrences: [
      hit(a, "bad_arguments", "update_task"),
      hit(a, "bad_arguments", "update_task"),
      hit(a, "tool_fault", "send"),
      hit(b, "bad_arguments", "update_task"),
      hit(bumpy, "tool_fault", "send"),
    ],
    costKnown: true,
  });
  assert.deepEqual(
    page.groups.map((group) => [
      group.result,
      group.reason,
      group.tasks,
      group.costUsd,
      group.timeMs,
    ]),
    [
      ["not_completed", "failed_call", 2, 0.75, 120_000],
      ["not_completed", "gave_up", 1, 0, 60_000],
      // A task completed after friction counts its extra turns, not the whole task.
      ["completed_after_friction", "recovered_call", 1, 0.5, 30_000],
    ],
  );
  assert.deepEqual(
    page.groups[0]!.rows.map((row) => [row.cause, row.tool, row.tasks, row.costUsd]),
    [
      ["bad_arguments", "update_task", 2, 0.75],
      ["tool_fault", "send", 1, 0.5],
    ],
  );
  // A task nothing named a cause for still shows under its reason.
  assert.deepEqual(
    page.groups[1]!.rows.map((row) => [row.cause, row.tool, row.tasks]),
    [[null, null, 1]],
  );
});

test("groups and rows follow the order asked for, and filters narrow them", () => {
  const cheap = task({ result: "not_completed", reason: "failed_call", costUsd: 0.1 });
  const cheap2 = task({ result: "not_completed", reason: "failed_call", costUsd: 0.1 });
  const dear = task({
    result: "not_completed",
    reason: "no_tool",
    costUsd: 5,
    startedAt: new Date("2026-09-02T09:00:00Z"),
  });
  const occurrences = [
    hit(cheap, "bad_arguments", "a"),
    hit(cheap2, "bad_arguments", "a"),
    hit(dear, "missing_capability"),
  ];
  const by = (sort: SentimentSort) =>
    overview([cheap, cheap2, dear], { occurrences, sort, costKnown: true }).groups.map(
      (group) => group.reason,
    );
  assert.deepEqual(by("impact"), ["failed_call", "no_tool"]);
  assert.deepEqual(by("cost"), ["no_tool", "failed_call"]);
  assert.deepEqual(by("time"), ["no_tool", "failed_call"]);

  const narrowed = overview([cheap, cheap2, dear], {
    occurrences,
    filters: { task: "not_completed", reason: "no_tool" },
  });
  assert.deepEqual(
    narrowed.groups.map((group) => group.reason),
    ["no_tool"],
  );
  // The reason choices are counted before the filters, so picking one keeps the others.
  assert.deepEqual(
    narrowed.reasons.map((entry) => [entry.result, entry.reason, entry.tasks]),
    [
      ["not_completed", "failed_call", 2],
      ["not_completed", "no_tool", 1],
    ],
  );
  assert.equal(
    overview([cheap, cheap2, dear], { occurrences, filters: { tool: "a" } }).groups[0]!.tasks,
    2,
  );
  // Without a costed call, cost is not shown.
  assert.equal(overview([cheap], { occurrences }).groups[0]!.costUsd, null);
});

test("a reason lists its first root causes; under its filter, all of them", () => {
  const tasks = Array.from({ length: REASON_ROWS + 2 }, () =>
    task({ result: "not_completed", reason: "failed_call" }),
  );
  const occurrences = tasks.map((t, i) => hit(t, "bad_arguments", `tool-${i}`));
  const capped = overview(tasks, { occurrences }).groups[0]!;
  assert.deepEqual(
    [capped.rows.length, capped.moreRows, capped.tasks],
    [REASON_ROWS, 2, REASON_ROWS + 2],
  );
  const all = overview(tasks, { occurrences, filters: { reason: "failed_call" } }).groups[0]!;
  assert.deepEqual([all.rows.length, all.moreRows], [REASON_ROWS + 2, 0]);
});

test("satisfaction day by day averages each day with the days before it, so a day of few answers does not swing it", () => {
  const day1 = { endedAt: new Date("2026-09-01T08:00:00Z") };
  const day3 = { endedAt: new Date("2026-09-03T08:00:00Z") };
  const tasks = [
    task(day1),
    task({ ...day1, result: "not_completed", reason: "gave_up" }),
    task(day3),
  ];
  const page = overview(tasks, {
    answers: [answer(tasks[0]!, true), answer(tasks[1]!, false), answer(tasks[2]!, true)],
  });
  assert.deepEqual(
    page.daily.map((day) => [
      day.day,
      day.answers,
      day.satisfied,
      day.satisfaction,
      day.windowAnswers,
    ]),
    [
      // The window's first day is partial (it opens at noon three days back) and has no answer here.
      ["2026-08-31", 0, 0, null, 0],
      ["2026-09-01", 2, 1, 0.5, 2],
      // No answer that day: the line carries the days before it.
      ["2026-09-02", 0, 0, 0.5, 2],
      ["2026-09-03", 1, 1, 2 / 3, 3],
    ],
  );
  assert.deepEqual(page.reasons, [{ result: "not_completed", reason: "gave_up", tasks: 1 }]);
});

test("an answer on the window's partial first day is on the line, so the days add up to the headline", () => {
  const early = task({ endedAt: new Date("2026-08-31T18:00:00Z") });
  const later = task();
  const page = overview([early, later], {
    answers: [answer(early, false), answer(later, true)],
  });
  assert.deepEqual(page.daily[0], {
    day: "2026-08-31",
    answers: 1,
    satisfied: 0,
    satisfaction: 0,
    windowAnswers: 1,
  });
  assert.equal(
    page.daily.reduce((total, day) => total + day.answers, 0),
    page.satisfaction.answers,
  );
});

test("a day with no answer in its window is a gap", () => {
  const page = overview([task()]);
  assert.deepEqual(
    page.daily.map((day) => day.satisfaction),
    [null, null, null, null],
  );
});

test("friction costs only the extra turns, failure the whole task; avoidable friction is the part with a cause somebody can fix", () => {
  const hour = {
    startedAt: new Date("2026-09-02T09:00:00Z"),
    endedAt: new Date("2026-09-02T10:00:00Z"),
  };
  const failed = task({ result: "not_completed", reason: "failed_call", costUsd: 1, ...hour });
  const fixable = task({
    result: "completed_after_friction",
    reason: "recovered_call",
    costUsd: 5,
    friction: { extraTurns: 2, retriedCalls: 0, tokens: null, costUsd: 0.5, timeMs: 60_000 },
  });
  const blameless = task({
    result: "completed_after_friction",
    reason: "repeated",
    costUsd: 5,
    friction: { extraTurns: 1, retriedCalls: 0, tokens: null, costUsd: 0.25, timeMs: 30_000 },
  });
  const inTurn = task({
    result: "completed_after_friction",
    reason: "recovered_call",
    costUsd: 2,
    friction: { extraTurns: 0, retriedCalls: 0, tokens: null, costUsd: 0, timeMs: 0 },
  });
  const page = overview([failed, fixable, blameless, inTurn], {
    occurrences: [
      hit(failed, "tool_fault", "send"),
      hit(fixable, "bad_arguments", "update_task"),
      hit(blameless, "correct_refusal"),
    ],
    costKnown: true,
  });
  assert.deepEqual(page.failure, { tasks: 1, costUsd: 1, tokens: null, timeMs: 3_600_000 });
  assert.deepEqual(page.friction, {
    tasks: 3,
    costUsd: 0.75,
    tokens: null,
    timeMs: 90_000,
    extraTurns: 3,
    retriedCalls: 0,
    inTurn: 1,
    avoidable: { tasks: 1, costUsd: 0.5, tokens: null, timeMs: 60_000 },
  });
  const recovered = page.groups.find((group) => group.reason === "recovered_call")!;
  assert.deepEqual([recovered.costUsd, recovered.extraTurns], [0.5, 2]);
  assert.deepEqual(
    recovered.rows.map((row) => [row.cause, row.avoidable]),
    [
      // One task each: the tie goes by key, and a task with no cause named sorts first.
      [null, "unknown"],
      ["bad_arguments", "agent"],
    ],
  );
});

test("whose fix avoids a cause, and a root cause keeps its newest tasks as examples", () => {
  assert.deepEqual(
    (
      [
        "bad_arguments",
        "tool_fault",
        "not_allowed",
        "missing_capability",
        "correct_refusal",
      ] as const
    ).map(avoidabilityOf),
    ["agent", "tool_owner", "setup", "new_tool", "not_avoidable"],
  );
  const tasks = Array.from({ length: ROW_EXAMPLES + 2 }, (_, i) =>
    task({
      result: "not_completed",
      reason: "failed_call",
      endedAt: new Date(Date.parse("2026-09-02T10:00:00Z") + i * 60_000),
    }),
  );
  const row = overview(tasks, {
    occurrences: tasks.map((t) => hit(t, "bad_arguments", "update_task")),
  }).groups[0]!.rows[0]!;
  assert.equal(row.examples.length, ROW_EXAMPLES);
  assert.equal(row.examples[0]!.taskId, tasks.at(-1)!.taskId, "newest first");
  assert.deepEqual(row.examples[0]!.turnIds, tasks.at(-1)!.turnIds);
});

test("dissatisfaction as a Pareto list: each unsatisfied turn under its cause, across tools; the fewest reaching 80% lead", () => {
  const tasks = Array.from({ length: 10 }, () =>
    task({ result: "not_completed", reason: "failed_call" }),
  );
  // Bad arguments on two tools (5 turns), a tool fault (3), a wrong reference (1), nothing named (1).
  const causes: Array<[Occurrence["cause"], string] | null> = [
    ...Array.from({ length: 3 }, (): [Occurrence["cause"], string] => [
      "bad_arguments",
      "update_task",
    ]),
    ...Array.from({ length: 2 }, (): [Occurrence["cause"], string] => [
      "bad_arguments",
      "filter_tasks",
    ]),
    ...Array.from({ length: 3 }, (): [Occurrence["cause"], string] => ["tool_fault", "send"]),
    ["wrong_reference", "entity_lookup"],
    null,
  ];
  const occurrences = causes.flatMap((cause, i) =>
    cause ? [hit(tasks[i]!, cause[0], cause[1])] : [],
  );
  const page = overview(tasks, {
    occurrences,
    answers: [...tasks.map((t) => answer(t, false)), answer(task(), false)],
  });
  assert.equal(page.dissatisfaction.turns, 10, "an answer outside the tasks in scope is left out");
  assert.deepEqual(
    page.dissatisfaction.problems.map((problem) => [
      problem.cause,
      problem.turns,
      problem.cumulative,
      problem.vital,
    ]),
    [
      ["bad_arguments", 5, 0.5, true],
      ["tool_fault", 3, 0.8, true],
      // The two above already reach 80%: the rest follow them.
      [null, 1, 0.9, false],
      ["wrong_reference", 1, 1, false],
    ],
  );
  assert.deepEqual(page.dissatisfaction.problems[0]!.tools, [
    { tool: "update_task", turns: 3 },
    { tool: "filter_tasks", turns: 2 },
  ]);
  assert.equal(page.dissatisfaction.vital, 2);
  // By whose problem: bad arguments and a wrong reference are the agent's, a tool fault the system's, nothing found is other.
  assert.deepEqual(
    page.dissatisfaction.groups.map((group) => [group.group, group.turns, group.share]),
    [
      ["agent", 6, 0.6],
      ["system", 3, 0.3],
      ["other", 1, 0.1],
    ],
  );
});

test("a failed call the agent made up for does not explain why someone was unsatisfied", () => {
  const recovered = task();
  const open = task();
  const streak = (made: boolean) => ({
    tool: "Bash",
    cause: "other",
    followed: made ? "fixed_next_try" : "nothing_followed",
    recovered: made,
  });
  const failing = (of: PageTask, made: boolean): ReturnType<typeof hit> => {
    const found = hit(of, "other", "Bash");
    return { ...found, turn: { ...found.turn, failures: [streak(made)] as never } };
  };
  const page = overview([recovered, open], {
    occurrences: [failing(recovered, true), failing(open, false)],
    answers: [answer(recovered, false), answer(open, false)],
  });
  assert.deepEqual(
    page.dissatisfaction.problems.map((problem) => [problem.cause, problem.turns]).sort(),
    [
      [null, 1],
      ["other", 1],
    ].sort(),
  );
});

test("tokens: failure counts a task's whole, friction only its own", () => {
  const failed = task({ result: "not_completed", reason: "failed_call", tokens: 1_000 });
  const bumpy = task({
    result: "completed_after_friction",
    reason: "recovered_call",
    tokens: 5_000,
    friction: { extraTurns: 1, retriedCalls: 0, tokens: 1_200, costUsd: null, timeMs: 0 },
  });
  const page = overview([failed, bumpy, task()]);
  assert.deepEqual([page.failure.tokens, page.friction.tokens], [1_000, 1_200]);
  assert.equal(
    overview([task({ result: "not_completed", reason: "failed_call" })]).failure.tokens,
    null,
    "none sent: none shown",
  );
});
