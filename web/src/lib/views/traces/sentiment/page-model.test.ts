import assert from "node:assert/strict";
import { test } from "node:test";
import type { StoredFailureStreak } from "@/lib/readings/trace-signals/outcomes/kinds";
import {
  buildSentimentPage,
  occurrencesOf,
  type PageSession,
  type PageTask,
  type PageTurn,
  type SentimentPageInput,
  unavailableSentimentPage,
  weekOf,
} from "@/lib/views/traces/sentiment/page-model";
import {
  DEFAULT_SENTIMENT_QUERY,
  NO_SENTIMENT_FILTERS,
  parseSentimentQuery,
  parseSentimentWindow,
  type SentimentQuery,
  sentimentHref,
} from "@/lib/views/traces/sentiment/page-paths";

const NOW = new Date("2026-09-02T00:00:00Z");
const P = "p1";

function streak(tool: string, over: Partial<StoredFailureStreak> = {}): StoredFailureStreak {
  return {
    tool,
    ordinal: 1,
    errors: 1,
    cause: "bad_arguments",
    followed: "fixed_next_try",
    recovered: true,
    ...over,
  };
}

let n = 0;
function turn(sessionId: string, over: Partial<PageTurn> = {}): PageTurn {
  n += 1;
  return {
    turnId: `t-${n}`,
    sessionId,
    startedAt: new Date("2026-09-01T09:59:00Z"),
    endedAt: new Date("2026-09-01T10:00:00Z"),
    costUsd: null,
    cause: null,
    causeSource: null,
    failures: [],
    unmetSearches: 0,
    satisfaction: null,
    reaction: null,
    ...over,
  };
}

function session(sessionId: string, over: Partial<PageSession> = {}): PageSession {
  return {
    sessionId,
    outcome: null,
    outcomeSource: null,
    frictionCount: 0,
    openRequest: false,
    endedAt: new Date("2026-09-01T10:00:00Z"),
    ...over,
  };
}

function input(turns: PageTurn[], over: Partial<SentimentPageInput> = {}): SentimentPageInput {
  const ids = [...new Set(turns.map((t) => t.sessionId))];
  return {
    projectId: P,
    windowDays: 30,
    now: NOW,
    turns,
    sessions: ids.map((id) => session(id, { frictionCount: 1 })),
    intents: new Map(),
    totals: {
      turns: turns.length,
      answered: 0,
      textTurns: 0,
      messages: 0,
      satisfaction: {},
      reactions: {},
    },
    modelConfigured: false,
    costKnown: false,
    answers: [],
    tasks: [],
    capped: false,
    minSessions: 3,
    ...over,
  };
}

const query = (over: Partial<SentimentQuery> = {}): SentimentQuery => ({
  ...DEFAULT_SENTIMENT_QUERY,
  ...over,
});

test("weeks start on Monday, UTC", () => {
  assert.equal(weekOf(new Date("2026-09-02T00:00:00Z")), "2026-08-31");
  assert.equal(weekOf(new Date("2026-08-31T00:00:00Z")), "2026-08-31");
  assert.equal(weekOf(new Date("2026-08-30T23:59:59Z")), "2026-08-24", "Sunday closes the week");
});

test("a turn's occurrences: one per cause and tool, a search nothing was run for, and an unsatisfied turn with no failed call", () => {
  const two = occurrencesOf(
    turn("s", {
      failures: [
        streak("a"),
        streak("a", { ordinal: 4, errors: 2, recovered: false }),
        streak("b", { cause: "tool_fault" }),
      ],
    }),
  );
  assert.deepEqual(
    two.map((o) => [o.cause, o.tool, o.errors, o.unresolved]),
    [
      ["bad_arguments", "a", 3, true],
      ["tool_fault", "b", 1, false],
    ],
  );
  assert.deepEqual(
    occurrencesOf(turn("s", { unmetSearches: 2 })).map((o) => [
      o.cause,
      o.tool,
      o.unresolved,
      o.source,
    ]),
    [["missing_capability", null, true, "rule"]],
  );
  assert.deepEqual(
    occurrencesOf(turn("s", { satisfaction: "unsatisfied" })).map((o) => [
      o.cause,
      o.tool,
      o.unresolved,
      o.source,
    ]),
    [["no_failure", null, true, "model"]],
  );
  assert.deepEqual(
    occurrencesOf(turn("s", { satisfaction: "satisfied" })),
    [],
    "a satisfied turn with no failure explains nothing",
  );
  // Recovered in the trace, and the person still was not satisfied.
  assert.equal(
    occurrencesOf(turn("s", { failures: [streak("a")], satisfaction: "unsatisfied" }))[0]
      ?.unresolved,
    true,
  );
});

test("a model's cause fills only the leading streak the rules left open", () => {
  const open = turn("s", {
    cause: "false_success",
    causeSource: "model",
    failures: [
      streak("a", { cause: "other", followed: "nothing_followed", recovered: false }),
      streak("b", { cause: null }),
    ],
  });
  assert.deepEqual(
    occurrencesOf(open).map((o) => [o.cause, o.tool, o.source]),
    [
      ["false_success", "a", "model"],
      ["unread", "b", "rule"],
    ],
  );
  const decided = turn("s", {
    cause: "tool_fault",
    causeSource: "rule",
    failures: [streak("a", { cause: "tool_fault" })],
  });
  assert.deepEqual(
    occurrencesOf(decided).map((o) => [o.cause, o.source]),
    [["tool_fault", "rule"]],
  );
});

test("a cause a model chose is a root cause even when every call worked, and a correct refusal is never unresolved", () => {
  const wrong = occurrencesOf(
    turn("s", { cause: "misread_request", causeSource: "model", satisfaction: "neutral" }),
  );
  assert.deepEqual(
    wrong.map((o) => [o.cause, o.tool, o.unresolved, o.source]),
    [["misread_request", null, true, "model"]],
  );

  const refused = occurrencesOf(
    turn("s", { cause: "correct_refusal", causeSource: "model", satisfaction: "unsatisfied" }),
  );
  assert.deepEqual(
    refused.map((o) => [o.cause, o.unresolved]),
    [["correct_refusal", false]],
  );
  // Refused over a failed call the rules could not sort: still not held against the agent.
  const refusedCall = occurrencesOf(
    turn("s", {
      cause: "correct_refusal",
      causeSource: "model",
      failures: [streak("a", { cause: "other", recovered: false })],
    }),
  );
  assert.deepEqual(
    refusedCall.map((o) => [o.cause, o.tool, o.unresolved]),
    [["correct_refusal", "a", false]],
  );

  // A search nothing was run for and a model saying the agent cannot do it are one cause, read both ways.
  const both = occurrencesOf(
    turn("s", { unmetSearches: 1, cause: "missing_capability", causeSource: "model" }),
  );
  assert.deepEqual(
    both.map((o) => [o.cause, o.source, o.unresolved]),
    [["missing_capability", "mixed", true]],
  );
  // A model's cause beside a streak the rules did sort stands as its own occurrence.
  const beside = occurrencesOf(
    turn("s", { unmetSearches: 1, cause: "incomplete", causeSource: "model" }),
  );
  assert.deepEqual(
    beside.map((o) => o.cause),
    ["missing_capability", "incomplete"],
  );
});

test("the text state: none sent, the model off, partly read, read", () => {
  const totals = (over: Partial<SentimentPageInput["totals"]>) => ({
    turns: 10,
    answered: 0,
    textTurns: 0,
    messages: 0,
    satisfaction: {},
    reactions: {},
    ...over,
  });
  const state = (over: Partial<SentimentPageInput>) =>
    buildSentimentPage(input([], { sessions: [session("a")], ...over }), query()).text;

  assert.deepEqual(state({ totals: totals({}) }), {
    state: "no_text",
    textTurns: 0,
    answeredTurns: 0,
    satisfactionTurns: 0,
    satisfaction: null,
    score: null,
    reactions: null,
    inferred: null,
  });
  assert.equal(state({ totals: totals({ textTurns: 8, messages: 12 }) }).state, "model_off");
  assert.equal(
    state({ totals: totals({ messages: 3 }) }).state,
    "model_off",
    "messages on turns with no call still count as text",
  );
  assert.equal(
    state({ totals: totals({ textTurns: 8 }), modelConfigured: true }).state,
    "capped",
    "a key and nothing answered yet",
  );
  const partly = state({
    totals: totals({
      textTurns: 8,
      answered: 5,
      satisfaction: { satisfied: 3, unsatisfied: 2 },
      reactions: { repeats: 2, odd: 1 },
    }),
  });
  assert.equal(partly.state, "capped");
  assert.deepEqual(partly.satisfaction, { satisfied: 3, neutral: 0, unsatisfied: 2, unknown: 0 });
  assert.equal(partly.reactions?.repeats, 2);
  assert.equal(
    state({ totals: totals({ textTurns: 8, answered: 8 }), modelConfigured: true }).state,
    "read",
  );
});

test("the satisfaction count is the turns with a satisfaction answer, not the turns a model answered about", () => {
  const totals = {
    turns: 10,
    messages: 8,
    textTurns: 8,
    answered: 8,
    satisfaction: { satisfied: 3, unsatisfied: 2, unknown: 1, odd: 4 },
    reactions: { repeats: 2 },
  };
  const text = buildSentimentPage(
    input([], { sessions: [session("a")], totals, modelConfigured: true }),
    query(),
  ).text;

  // Every turn with a message was answered about; two of them have no satisfaction answer.
  assert.equal(text.state, "read");
  assert.deepEqual([text.textTurns, text.answeredTurns, text.satisfactionTurns], [8, 8, 6]);
  assert.equal(
    Object.values(text.satisfaction!).reduce((sum, n) => sum + n, 0),
    text.satisfactionTurns,
    "the classes add up to the count shown beside them",
  );

  // A message and no answer at all: nothing to count.
  const unread = buildSentimentPage(
    input([], {
      sessions: [session("a")],
      totals: { ...totals, answered: 0, satisfaction: {}, reactions: {} },
      modelConfigured: true,
    }),
    query(),
  ).text;
  assert.deepEqual([unread.state, unread.textTurns, unread.satisfactionTurns], ["capped", 8, 0]);
});

test("no rows and no sessions is the empty page", () => {
  const page = buildSentimentPage(
    input([], {
      sessions: [],
      totals: { turns: 0, answered: 0, textTurns: 0, messages: 0, satisfaction: {}, reactions: {} },
    }),
    query(),
  );
  assert.equal(page.state, "empty");
  assert.equal(page.overview.tasks, 0);
});

test("sort and filters live in the URL and read back", () => {
  const filters = {
    intent: "i-1",
    cause: "tool_fault" as const,
    tool: "skill:report",
    week: "2026-08-31",
    outcome: "gave_up" as const,
    task: "not_completed" as const,
    reason: "failed_call" as const,
  };
  const href = sentimentHref(P, {
    days: 90,
    filters,
    sort: "share",
    open: "i-1|tool_fault|skill%3Areport",
  });
  const url = new URL(href, "https://cloud.ratel.sh");
  assert.equal(url.pathname, "/project/p1/traces/sentiment");
  const parsed = parseSentimentQuery(Object.fromEntries(url.searchParams));
  assert.deepEqual(parsed, {
    filters,
    sort: "share",
    open: "i-1|tool_fault|skill%3Areport",
  });
  assert.equal(parseSentimentWindow(url.searchParams.get("days") ?? undefined, 90), 90);

  assert.equal(sentimentHref(P), "/project/p1/traces/sentiment", "the defaults are the bare path");
  assert.equal(
    sentimentHref(P, { days: 30, sort: "impact", filters: NO_SENTIMENT_FILTERS }),
    "/project/p1/traces/sentiment",
  );
  assert.deepEqual(
    parseSentimentQuery({
      cause: "made_up",
      sort: "sideways",
      week: "last week",
      ended: "happily",
      task: "maybe",
      why: "because",
    }),
    DEFAULT_SENTIMENT_QUERY,
  );
  assert.equal(parseSentimentWindow(undefined, 90), 30, "a month by default");
  assert.equal(parseSentimentWindow("90", 30), 30, "within the plan's window");
  assert.equal(parseSentimentWindow(undefined, 7), 7);
});

test("the satisfaction score is the satisfied share of turns the person said how it went; none without an answer", () => {
  const totals = {
    turns: 10,
    messages: 8,
    textTurns: 8,
    answered: 8,
    satisfaction: { satisfied: 3, unsatisfied: 1, neutral: 4 },
    reactions: {},
  };
  assert.equal(
    buildSentimentPage(
      input([], { sessions: [session("a")], totals, modelConfigured: true }),
      query(),
    ).text.score,
    0.75,
    "neutral turns are left out",
  );
  const neutral = { ...totals, satisfaction: { neutral: 8 } };
  assert.equal(
    buildSentimentPage(
      input([], { sessions: [session("a")], totals: neutral, modelConfigured: true }),
      query(),
    ).text.score,
    null,
  );
  assert.equal(
    buildSentimentPage(input([turn("a", { failures: [streak("x")] })]), query()).text.score,
    null,
    "no messages, no score",
  );
});

test("without a costed model call there is no cost, and ordering by cost falls back to unresolved", () => {
  const page = buildSentimentPage(
    input([turn("a", { failures: [streak("update_task")] })]),
    query({ sort: "cost" }),
  );
  assert.equal(page.costKnown, false);
  assert.equal(page.query.sort, "impact");
  assert.equal(
    buildSentimentPage(input([], { costKnown: true }), query({ sort: "cost" })).query.sort,
    "cost",
  );
});

test("intents rank by their satisfaction score, few answers marked not dropped; a session outcome narrows them", () => {
  const sessions = [
    session("a", { outcome: "gave_up", outcomeSource: "model" }),
    session("b", { outcome: "gave_up", outcomeSource: "model" }),
    session("c", { outcome: "resolved_clean", outcomeSource: "model" }),
  ];
  const answer = (turnId: string, sessionId: string, satisfied: boolean) => ({
    turnId,
    sessionId,
    satisfied,
  });
  const answers = [
    answer("t-a1", "a", false),
    answer("t-a2", "a", false),
    answer("t-b1", "b", true),
    answer("t-b2", "b", false),
    answer("t-c1", "c", true),
    answer("t-c2", "c", true),
    answer("t-c3", "c", true),
    answer("t-x", "c", true),
  ];
  const intents = new Map([
    ["t-a1", { id: "move", label: "Move tasks" }],
    ["t-a2", { id: "move", label: "Move tasks" }],
    ["t-b2", { id: "move", label: "Move tasks" }],
    ["t-b1", { id: "create", label: "Create task" }],
    ["t-c1", { id: "create", label: "Create task" }],
    ["t-c2", { id: "create", label: "Create task" }],
    ["t-c3", { id: "lone", label: "Archive project" }],
  ]);
  const totals = {
    turns: 8,
    messages: 8,
    textTurns: 8,
    answered: 8,
    satisfaction: { satisfied: 5, unsatisfied: 3 },
    reactions: {},
  };
  const page = buildSentimentPage(
    input([], { sessions, answers, intents, totals, modelConfigured: true }),
    query(),
  );

  const scores = page.intentScores!;
  // Archive project scores 1 on one answer: ranked, after the intent with the same score on more answers.
  assert.deepEqual(
    scores.satisfied.map((s) => [s.intent.id, s.score, s.said]),
    [
      ["create", 1, 3],
      ["lone", 1, 1],
    ],
  );
  assert.deepEqual(
    scores.unsatisfied.map((s) => [s.intent.id, s.score, s.said]),
    [["move", 0, 3]],
  );
  assert.equal(scores.fewAnswers, 3);

  // Under a session outcome, the intents of sessions that ended that way.
  const gaveUp = buildSentimentPage(
    input([], { sessions, answers, intents, totals, modelConfigured: true }),
    query({ filters: { ...NO_SENTIMENT_FILTERS, outcome: "gave_up" } }),
  );
  assert.deepEqual(
    gaveUp.intentScores!.unsatisfied.map((s) => [s.intent.id, s.said]),
    [["move", 3]],
  );
  assert.deepEqual(
    gaveUp.intentScores!.satisfied.map((s) => [s.intent.id, s.said]),
    [["create", 1]],
    "one answer in a session that gave up",
  );

  // Without people's messages there is nothing to rank.
  assert.equal(
    buildSentimentPage(input([turn("a", { failures: [streak("x")] })]), query()).intentScores,
    null,
  );
});

test("five intents a side at most, the most satisfied first and the least satisfied first", () => {
  const sessions = [session("s", { outcome: "resolved_clean", outcomeSource: "model" })];
  const answers: Array<{ turnId: string; sessionId: string; satisfied: boolean }> = [];
  const intents = new Map<string, { id: string; label: string }>();
  // 13 intents of 4 answers each, satisfied in 0 to 4 of them: three at 0, three at 1, three at 3, four at 4.
  const scoresOf = [0, 1, 1, 1, 0, 0, 3, 4, 4, 3, 4, 3, 4];
  scoresOf.forEach((satisfied, i) => {
    for (let k = 0; k < 4; k++) {
      const turnId = `i${i}-${k}`;
      answers.push({ turnId, sessionId: "s", satisfied: k < satisfied });
      intents.set(turnId, { id: `i${i}`, label: `Intent ${String(i).padStart(2, "0")}` });
    }
  });
  const totals = {
    turns: 52,
    messages: 52,
    textTurns: 52,
    answered: 52,
    satisfaction: { satisfied: 1, unsatisfied: 1 },
    reactions: {},
  };
  const scores = buildSentimentPage(
    input([], { sessions, answers, intents, totals, modelConfigured: true }),
    query(),
  ).intentScores!;
  assert.deepEqual(
    scores.satisfied.map((s) => s.score),
    [1, 1, 1, 1, 0.75],
  );
  assert.deepEqual(
    scores.unsatisfied.map((s) => s.score),
    [0, 0, 0, 0.25, 0.25],
  );
});

test("task completion follows an intent: the tasks whose first turn is that intent", () => {
  const a = turn("a", { failures: [streak("update_task", { recovered: false })] });
  const b = turn("b", { failures: [streak("create_task", { recovered: false })] });
  const tasks: PageTask[] = [a, b].map((t, i) => ({
    taskId: t.turnId,
    sessionId: t.sessionId,
    turnIds: [t.turnId],
    startedAt: t.startedAt,
    endedAt: t.endedAt,
    costUsd: null,
    tokens: null,
    friction: null,
    tier: "t2",
    goalSource: "request",
    result: i === 0 ? "not_completed" : "completed",
    reason: i === 0 ? "failed_call" : null,
    cause: null,
    checked: true,
  }));
  const intents = new Map([[a.turnId, { id: "area-1", label: "Task operations" }]]);
  const page = buildSentimentPage(
    input([a, b], { tasks, intents }),
    query({ filters: { ...NO_SENTIMENT_FILTERS, intent: "area-1" } }),
  );
  assert.equal(page.overview.tasks, 1);
  assert.deepEqual(
    page.overview.reasons.map((r) => r.reason),
    ["failed_call"],
  );
});

test("an intent filter names its intent for the chip; turns placed nowhere read as no intent", () => {
  const a = turn("a");
  const intents = new Map([[a.turnId, { id: "area-1", label: "Task operations" }]]);
  const named = (intent: string | null) =>
    buildSentimentPage(
      input([a], { intents }),
      query({ filters: { ...NO_SENTIMENT_FILTERS, intent } }),
    ).intentLabel;
  assert.equal(named("area-1"), "Task operations");
  assert.equal(named("none"), "No intent");
  assert.equal(
    named("gone"),
    "gone",
    "an intent no turn of the window is placed in reads as its id",
  );
  assert.equal(named(null), null);
  assert.equal(unavailableSentimentPage(P, 30, query()).intentLabel, null);
});
