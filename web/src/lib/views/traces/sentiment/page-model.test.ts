import assert from "node:assert/strict";
import { test } from "node:test";
import type { StoredFailureStreak } from "@/lib/readings/trace-signals/outcomes/kinds";
import { sessionOutcomeOf } from "@/lib/views/traces/sentiment/page-kinds";
import {
  buildSentimentPage,
  OTHER_INTENTS,
  occurrencesOf,
  type PageSession,
  type PageTask,
  type PageTurn,
  parseRowKey,
  rowKey,
  type SentimentPageInput,
  weekOf,
  weeksBetween,
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
    versions: new Map(),
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
  assert.deepEqual(weeksBetween(new Date("2026-08-03T00:00:00Z"), NOW), [
    "2026-08-03",
    "2026-08-10",
    "2026-08-17",
    "2026-08-24",
    "2026-08-31",
  ]);
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

  const page = buildSentimentPage(
    input(
      ["a", "b", "c"].map((id) =>
        turn(id, { cause: "correct_refusal", causeSource: "model", satisfaction: "unsatisfied" }),
      ),
    ),
    query(),
  );
  assert.deepEqual(
    page.rows.map((row) => [row.cause, row.owner, row.sessions, row.unresolved, row.readBy]),
    [["correct_refusal", "nobody", 3, 0, "model"]],
  );
  assert.equal(page.totals.unresolved, 0);
});

test("a row is an intent, a cause and a tool; thin rows are hidden and counted; the rest rank by sessions not recovered", () => {
  const turns = [
    ...["a", "b", "c", "d"].map((id) => turn(id, { failures: [streak("update_task")] })),
    ...["e", "f", "g"].map((id) =>
      turn(id, { failures: [streak("send_report", { cause: "tool_fault", recovered: false })] }),
    ),
    turn("h", { failures: [streak("archive_board", { cause: "other", recovered: false })] }),
    turn("a", { unmetSearches: 1 }),
  ];
  const intents = new Map(
    turns.slice(0, 4).map((t) => [t.turnId, { id: "i-1", label: "Update a task" }]),
  );
  const page = buildSentimentPage(input(turns, { intents }), query());

  assert.equal(page.state, "ready");
  assert.deepEqual(
    page.rows.map((row) => [
      row.intent?.label ?? null,
      row.cause,
      row.tool,
      row.sessions,
      row.unresolved,
      row.owner,
      row.readBy,
    ]),
    [
      [null, "tool_fault", "send_report", 3, 3, "tool_owner", "rule"],
      ["Update a task", "bad_arguments", "update_task", 4, 0, "prompt", "rule"],
    ],
  );
  assert.equal(page.rows[0]?.unresolvedShare, 1);
  // Session `a` is also in a shown row, so only `h` is held by hidden rows alone.
  assert.deepEqual(page.hidden, { rows: 2, sessions: 1, folded: 0 });
  assert.equal(page.minSessions, 3);
  assert.deepEqual(page.totals, { sessions: 8, turns: 9, affected: 8, unresolved: 5 });

  const all = buildSentimentPage(input(turns, { intents }), query({ thin: true }));
  assert.deepEqual(
    all.rows.map((row) => [row.cause, row.thin]),
    [
      ["tool_fault", false],
      ["missing_capability", true],
      ["other", true],
      ["bad_arguments", false],
    ],
  );

  const bySessions = buildSentimentPage(input(turns, { intents }), query({ sort: "sessions" }));
  assert.deepEqual(
    bySessions.rows.map((row) => row.tool),
    ["update_task", "send_report"],
  );
  const byShare = buildSentimentPage(input(turns, { intents }), query({ sort: "share" }));
  assert.deepEqual(
    byShare.rows.map((row) => row.tool),
    ["send_report", "update_task"],
  );
});

test("thin rows that share a cause and a tool fold into Other intents; asking for thin rows or one intent shows them as they are", () => {
  // Five intents, one session each, all failing update_task on bad arguments; one lone tool fault.
  const turns = [
    ...["a", "b", "c", "d", "e"].map((id) => turn(id, { failures: [streak("update_task")] })),
    turn("f", { failures: [streak("send_report", { cause: "tool_fault", recovered: false })] }),
  ];
  const intents = new Map(
    turns.slice(0, 5).map((t, i) => [t.turnId, { id: `i-${i}`, label: `Intent ${i}` }]),
  );
  const page = buildSentimentPage(input(turns, { intents }), query());

  assert.deepEqual(
    page.rows.map((row) => [row.intent, row.cause, row.tool, row.sessions, row.thin]),
    [[OTHER_INTENTS, "bad_arguments", "update_task", 5, false]],
  );
  assert.equal(page.rows[0]?.key, rowKey(OTHER_INTENTS.id, "bad_arguments", "update_task"));
  // The lone tool fault has nothing to fold with: still hidden and counted.
  assert.deepEqual(page.hidden, { rows: 1, sessions: 1, folded: 5 });

  const thin = buildSentimentPage(input(turns, { intents }), query({ thin: true }));
  assert.equal(thin.rows.length, 6);
  assert.ok(thin.rows.every((row) => row.thin && row.intent?.id !== OTHER_INTENTS.id));
  assert.equal(thin.hidden.folded, 0);

  // One intent is a slice: its row shows however few sessions, and the page says why.
  const one = buildSentimentPage(
    input(turns, { intents }),
    query({ filters: { ...NO_SENTIMENT_FILTERS, intent: "i-0" } }),
  );
  assert.deepEqual(
    [one.rows.length, one.hidden.rows, one.hidden.folded, one.thinForced],
    [1, 1, 0, true],
  );
  assert.equal(one.rows[0]?.thin, true);
});

test("a row key reads back as its intent, cause and tool", () => {
  const key = rowKey("i-1", "bad_arguments", "skill:crm/update|task");
  assert.deepEqual(parseRowKey(key), {
    intent: "i-1",
    cause: "bad_arguments",
    tool: "skill:crm/update|task",
  });
  assert.deepEqual(parseRowKey(rowKey(null, "missing_capability", null)), {
    intent: null,
    cause: "missing_capability",
    tool: null,
  });
  assert.equal(parseRowKey("nonsense"), null);
  assert.equal(parseRowKey("none|made_up|x"), null);
});

test("trends are weekly, and a row starts on the catalog version of its first turn", () => {
  const old = new Date("2026-08-18T10:00:00Z");
  const turns = [
    ...["a", "b"].map((id) => turn(id, { failures: [streak("update_task")], endedAt: old })),
    ...["c", "d", "e"].map((id) => turn(id, { failures: [streak("update_task")] })),
  ];
  const versions = new Map(turns.map((t, i) => [t.turnId, i < 2 ? "v1" : "v2"]));
  const page = buildSentimentPage(input(turns, { versions }), query());

  assert.deepEqual(page.weeks, [
    "2026-08-03",
    "2026-08-10",
    "2026-08-17",
    "2026-08-24",
    "2026-08-31",
  ]);
  const [row] = page.rows;
  assert.deepEqual(row?.trend, [0, 0, 2, 0, 3]);
  assert.equal(row?.startedVersion, "v1");
  assert.equal(row?.firstSeen, old.toISOString());
  assert.equal(row?.lastSeen, "2026-09-01T10:00:00.000Z");
  assert.deepEqual(
    page.cuts.version.values.map((value) => [value.key, value.sessions]),
    [
      ["v1", 2],
      ["v2", 3],
    ],
  );
  assert.deepEqual(
    page.cuts.week.values.map((value) => [value.key, value.sessions]),
    [
      ["2026-08-03", 0],
      ["2026-08-10", 0],
      ["2026-08-17", 2],
      ["2026-08-24", 0],
      ["2026-08-31", 3],
    ],
  );
});

test("a filter narrows the rows and the sessions, and each cut still lists its other values", () => {
  const turns = [
    ...["a", "b", "c"].map((id) => turn(id, { failures: [streak("update_task")] })),
    ...["d", "e", "f"].map((id) =>
      turn(id, { failures: [streak("send_report", { cause: "tool_fault", recovered: false })] }),
    ),
  ];
  const page = buildSentimentPage(
    input(turns),
    query({ filters: { ...NO_SENTIMENT_FILTERS, tool: "send_report" } }),
  );

  assert.deepEqual(
    page.rows.map((row) => row.tool),
    ["send_report"],
  );
  assert.equal(page.totals.sessions, 3);
  assert.equal(page.split.total, 3);
  assert.deepEqual(
    page.cuts.tool.values.map((value) => [value.key, value.sessions, value.active]),
    [
      ["send_report", 3, true],
      ["update_task", 3, false],
    ],
  );
  // The intent cut is under the tool filter: only the filtered tool's sessions.
  assert.deepEqual(
    page.cuts.intent.values.map((value) => [value.key, value.label, value.sessions]),
    [["none", "No intent", 3]],
  );

  const byCause = buildSentimentPage(
    input(turns),
    query({ filters: { ...NO_SENTIMENT_FILTERS, cause: "bad_arguments", intent: "none" } }),
  );
  assert.deepEqual(
    byCause.rows.map((row) => row.tool),
    ["update_task"],
  );
});

test("the session split uses the stored outcome, and reads a row the fusion has not reached from its rule columns", () => {
  assert.deepEqual(sessionOutcomeOf(session("s")), { outcome: "resolved_clean", source: "rule" });
  assert.deepEqual(sessionOutcomeOf(session("s", { frictionCount: 2 })), {
    outcome: "resolved_after_friction",
    source: "rule",
  });
  assert.deepEqual(sessionOutcomeOf(session("s", { frictionCount: 2, openRequest: true })), {
    outcome: "gave_up",
    source: "rule",
  });
  assert.deepEqual(
    sessionOutcomeOf(
      session("s", { outcome: "gave_up", outcomeSource: "model", openRequest: true }),
    ),
    { outcome: "gave_up", source: "model" },
  );
  assert.deepEqual(
    sessionOutcomeOf(
      session("s", { outcome: "blocked", outcomeSource: "rule", openRequest: true }),
    ),
    { outcome: "blocked", source: "rule" },
  );
  assert.deepEqual(
    sessionOutcomeOf(session("s", { outcome: "a class not known here", outcomeSource: "model" })),
    { outcome: "resolved_clean", source: "rule" },
  );

  const sessions = [
    session("a"),
    session("b", { frictionCount: 1 }),
    session("c", { openRequest: true }),
    session("d", { outcome: "escalated", outcomeSource: "model" }),
  ];
  const page = buildSentimentPage(
    input([], {
      sessions,
      totals: { turns: 4, answered: 0, textTurns: 0, messages: 0, satisfaction: {}, reactions: {} },
    }),
    query(),
  );
  assert.deepEqual(
    page.split.classes.map((c) => [c.outcome, c.sessions]),
    [
      ["resolved_clean", 1],
      ["resolved_after_friction", 1],
      ["gave_up", 1],
      ["blocked", 0],
      ["escalated", 1],
    ],
  );
  assert.equal(page.split.readBy, "mixed");
  assert.equal(page.split.classes[0]?.share, 0.25);
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

test("a row counts what the person did next on the turns a model answered about", () => {
  const turns = [
    turn("a", {
      failures: [streak("update_task")],
      satisfaction: "unsatisfied",
      reaction: "repeats",
    }),
    turn("b", {
      failures: [streak("update_task")],
      satisfaction: "unsatisfied",
      reaction: "repeats",
    }),
    turn("c", {
      failures: [streak("update_task")],
      satisfaction: "satisfied",
      reaction: "new_request",
    }),
    turn("d", { failures: [streak("update_task")] }),
  ];
  const [row] = buildSentimentPage(input(turns), query()).rows;
  assert.deepEqual([row?.sessions, row?.unresolved, row?.answered, row?.unsatisfied], [4, 2, 3, 2]);
  assert.deepEqual(row?.reactions, { repeats: 2, new_request: 1 });
  assert.deepEqual(
    row?.examples
      .slice(0, 2)
      .map((example) => example.sessionId)
      .sort(),
    ["a", "b"],
    "unresolved sessions lead the examples",
  );
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
  assert.deepEqual(page.rows, []);
});

test("sort and filters live in the URL and read back", () => {
  const filters = {
    intent: "i-1",
    cause: "tool_fault" as const,
    tool: "skill:report",
    week: "2026-08-31",
    version: "v2",
    outcome: "gave_up" as const,
    task: "not_completed" as const,
    reason: "failed_call" as const,
  };
  const href = sentimentHref(P, {
    days: 90,
    filters,
    sort: "share",
    thin: true,
    open: rowKey("i-1", "tool_fault", "skill:report"),
  });
  const url = new URL(href, "https://cloud.ratel.sh");
  assert.equal(url.pathname, "/project/p1/traces/sentiment");
  const parsed = parseSentimentQuery(Object.fromEntries(url.searchParams));
  assert.deepEqual(parsed, {
    filters,
    sort: "share",
    thin: true,
    page: 1,
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
      thin: "yes",
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

/** Three sessions of one cause and tool, each turn taking `seconds` and costing `cost`. */
function spent(
  tool: string,
  cause: StoredFailureStreak["cause"],
  seconds: number,
  cost: number | null,
  recovered = true,
): PageTurn[] {
  return ["1", "2", "3"].map((s) =>
    turn(`${tool}-${s}`, {
      startedAt: new Date(new Date("2026-09-01T10:00:00Z").getTime() - seconds * 1000),
      endedAt: new Date("2026-09-01T10:00:00Z"),
      costUsd: cost,
      failures: [streak(tool, { cause, recovered })],
    }),
  );
}

test("rows group by cause; groups and their rows follow the order, cost and time each count a turn once", () => {
  const turns = [
    ...spent("update_task", "bad_arguments", 10, 0.01, false),
    ...spent("create_task", "bad_arguments", 60, 0.002),
    ...spent("send_report", "tool_fault", 120, 0.5),
  ];
  const page = buildSentimentPage(input(turns, { costKnown: true }), query());
  assert.deepEqual(
    page.groups.map((g) => [
      g.cause,
      g.sessions,
      g.unresolved,
      g.rowCount,
      g.rows.map((r) => r.tool),
      g.continued,
    ]),
    [
      ["bad_arguments", 6, 3, 2, ["update_task", "create_task"], false],
      ["tool_fault", 3, 0, 1, ["send_report"], false],
    ],
  );
  assert.deepEqual(
    page.rows.map((r) => r.tool),
    ["update_task", "create_task", "send_report"],
    "the page's rows in the order listed",
  );
  const [bad] = page.groups;
  assert.equal(bad?.timeMs, 3 * 10_000 + 3 * 60_000);
  assert.ok(Math.abs((bad?.costUsd ?? 0) - 0.036) < 1e-9);
  assert.equal(
    page.top?.tool,
    "update_task",
    "the top row is the one left unresolved most, whatever the order",
  );

  const byCost = buildSentimentPage(input(turns, { costKnown: true }), query({ sort: "cost" }));
  assert.deepEqual(
    byCost.groups.map((g) => g.cause),
    ["tool_fault", "bad_arguments"],
  );
  assert.deepEqual(
    byCost.groups[1]?.rows.map((r) => r.tool),
    ["update_task", "create_task"],
  );
  const byTime = buildSentimentPage(input(turns, { costKnown: true }), query({ sort: "time" }));
  assert.deepEqual(
    byTime.groups.map((g) => g.cause),
    ["tool_fault", "bad_arguments"],
  );
  assert.deepEqual(
    byTime.groups[1]?.rows.map((r) => r.tool),
    ["create_task", "update_task"],
  );
  assert.equal(byTime.top?.tool, "update_task");
});

test("without a costed model call there is no cost, and ordering by cost falls back to unresolved", () => {
  const turns = [
    ...spent("update_task", "bad_arguments", 10, null, false),
    ...spent("send_report", "tool_fault", 120, null),
  ];
  const page = buildSentimentPage(input(turns), query({ sort: "cost" }));
  assert.equal(page.costKnown, false);
  assert.equal(page.query.sort, "impact");
  assert.deepEqual(
    page.rows.map((r) => [r.tool, r.costUsd]),
    [
      ["update_task", null],
      ["send_report", null],
    ],
  );
});

test("root causes come a page at a time; a group split across pages says it continues, and a page past the end reads as the last", () => {
  const tools = Array.from({ length: 25 }, (_, i) => `tool_${String(i).padStart(2, "0")}`);
  const turns = tools.flatMap((tool, i) =>
    spent(tool, i < 22 ? "bad_arguments" : "tool_fault", 1, null),
  );
  const first = buildSentimentPage(input(turns), query());
  assert.deepEqual(first.pagination, { page: 1, pages: 2, size: 20, total: 25, from: 1, to: 20 });
  assert.deepEqual(
    first.groups.map((g) => [g.cause, g.rows.length, g.rowCount, g.continued]),
    [["bad_arguments", 20, 22, false]],
  );

  const second = buildSentimentPage(input(turns), query({ page: 2 }));
  assert.deepEqual([second.pagination.from, second.pagination.to], [21, 25]);
  assert.deepEqual(
    second.groups.map((g) => [g.cause, g.rows.length, g.continued]),
    [
      ["bad_arguments", 2, true],
      ["tool_fault", 3, false],
    ],
  );
  const past = buildSentimentPage(input(turns), query({ page: 9 }));
  assert.equal(past.pagination.page, 2);
  assert.equal(past.query.page, 2);
});

test("the page number lives in the URL; the first page is the bare path", () => {
  assert.equal(sentimentHref(P, { page: 1 }), "/project/p1/traces/sentiment");
  assert.equal(
    sentimentHref(P, { sort: "cost", page: 3 }),
    "/project/p1/traces/sentiment?sort=cost&page=3",
  );
  assert.equal(parseSentimentQuery({ page: "3", sort: "time" }).page, 3);
  assert.equal(parseSentimentQuery({ sort: "time" }).sort, "time");
  for (const odd of ["0", "-2", "two", "99999999"])
    assert.equal(parseSentimentQuery({ page: odd }).page, 1, odd);
});

test("picking how sessions ended narrows the root causes to those sessions; the split still counts every way they ended", () => {
  const turns = [
    ...["a", "b", "c"].map((id) =>
      turn(id, { failures: [streak("update_task", { recovered: false })] }),
    ),
    ...["d", "e", "f"].map((id) =>
      turn(id, { failures: [streak("send_report", { cause: "tool_fault" })] }),
    ),
  ];
  const sessions = [
    ...["a", "b", "c"].map((id) => session(id, { outcome: "gave_up", outcomeSource: "rule" })),
    ...["d", "e", "f"].map((id) =>
      session(id, { outcome: "resolved_after_friction", outcomeSource: "rule" }),
    ),
    session("g", { outcome: "gave_up", outcomeSource: "rule" }),
    session("h", { outcome: "resolved_clean", outcomeSource: "rule" }),
  ];
  const all = buildSentimentPage(input(turns, { sessions }), query());
  assert.deepEqual(all.groups.map((g) => g.cause).sort(), ["bad_arguments", "tool_fault"]);

  const gaveUp = buildSentimentPage(
    input(turns, { sessions }),
    query({ filters: { ...NO_SENTIMENT_FILTERS, outcome: "gave_up" } }),
  );
  assert.deepEqual(
    gaveUp.rows.map((r) => [r.cause, r.tool, r.sessions]),
    [["bad_arguments", "update_task", 3]],
  );
  // Of the 4 sessions that gave up, 3 hit something; the split is the whole window's.
  assert.deepEqual([gaveUp.totals.sessions, gaveUp.totals.affected], [4, 3]);
  assert.deepEqual(
    gaveUp.split.classes.map((c) => [c.outcome, c.sessions]),
    [
      ["resolved_clean", 1],
      ["resolved_after_friction", 3],
      ["gave_up", 4],
      ["blocked", 0],
      ["escalated", 0],
    ],
  );

  const friction = buildSentimentPage(
    input(turns, { sessions }),
    query({ filters: { ...NO_SENTIMENT_FILTERS, outcome: "resolved_after_friction" } }),
  );
  assert.deepEqual(
    friction.groups.map((g) => [g.cause, g.sessions]),
    [["tool_fault", 3]],
  );

  // Another filter narrows the split too, but never by the outcome picked.
  const tool = buildSentimentPage(
    input(turns, { sessions }),
    query({ filters: { ...NO_SENTIMENT_FILTERS, tool: "send_report", outcome: "gave_up" } }),
  );
  assert.equal(tool.rows.length, 0);
  assert.deepEqual(
    tool.split.classes.filter((c) => c.sessions > 0).map((c) => [c.outcome, c.sessions]),
    [["resolved_after_friction", 3]],
  );
});

test("each way sessions ended carries its satisfaction score, and intents rank by theirs, five a side, few answers marked not dropped", () => {
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

  const byOutcome = Object.fromEntries(
    page.split.classes.map((c) => [c.outcome, [c.score, c.said]]),
  );
  assert.deepEqual(byOutcome.gave_up, [0.25, 4]);
  assert.deepEqual(byOutcome.resolved_clean, [1, 4]);
  assert.deepEqual(byOutcome.blocked, [null, 0]);

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

test("task completion: completed tasks whose goal nothing read count as completed, reasons of the ones not completed, and a task result or reason narrows the root causes", () => {
  const failing = turn("a", { failures: [streak("update_task", { recovered: false })] });
  const objected = turn("b", {
    satisfaction: "unsatisfied",
    cause: "misread_request",
    causeSource: "model",
  });
  const fine = turn("c", { failures: [streak("send_report", { cause: "tool_fault" })] });
  const task = (t: PageTurn, over: Partial<PageTask>): PageTask => ({
    taskId: t.turnId,
    sessionId: t.sessionId,
    turnIds: [t.turnId],
    startedAt: t.startedAt,
    endedAt: t.endedAt,
    costUsd: null,
    tokens: null,
    friction: null,
    tier: "t3",
    goalSource: "request",
    result: "completed",
    reason: null,
    cause: null,
    checked: true,
    ...over,
  });
  const tasks = [
    task(failing, { result: "not_completed", reason: "failed_call", cause: "bad_arguments" }),
    task(objected, { result: "not_completed", reason: "wrong_action", cause: "misread_request" }),
    task(fine, { result: "completed_after_friction" }),
    { ...task(turn("d"), { result: "completed", checked: false, tier: "t0", goalSource: "none" }) },
    {
      ...task(turn("e"), { result: "completed", checked: false, tier: "t1", goalSource: "search" }),
    },
  ];
  const turns = [failing, objected, fine];
  const page = buildSentimentPage(input(turns, { tasks }), query());
  assert.deepEqual(
    page.tasks.classes.map((c) => [c.filter, c.tasks]),
    [
      ["completed", 2],
      ["completed_after_friction", 1],
      ["not_completed", 2],
    ],
  );
  assert.deepEqual(
    page.tasks.reasons.map((r) => [r.reason, r.tasks, r.share]),
    [
      ["failed_call", 1, 0.5],
      ["wrong_action", 1, 0.5],
    ],
  );
  assert.deepEqual(page.tasks.tiers, { t0: 1, t1: 1, tr: 0, t2: 0, t3: 3 });

  // A reason narrows the root causes to its tasks' turns, and every row of that slice shows.
  const byReason = buildSentimentPage(
    input(turns, { tasks }),
    query({ filters: { ...NO_SENTIMENT_FILTERS, task: "not_completed", reason: "failed_call" } }),
  );
  assert.deepEqual(
    byReason.rows.map((r) => [r.cause, r.tool]),
    [["bad_arguments", "update_task"]],
  );
  assert.equal(byReason.thinForced, true);
  // The split is not narrowed by its own filters.
  assert.equal(byReason.tasks.total, 5);
  const notDone = buildSentimentPage(
    input(turns, { tasks }),
    query({ filters: { ...NO_SENTIMENT_FILTERS, task: "not_completed" } }),
  );
  assert.deepEqual(notDone.rows.map((r) => r.cause).sort(), ["bad_arguments", "misread_request"]);
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
  assert.equal(page.tasks.total, 1);
  assert.deepEqual(
    page.tasks.reasons.map((r) => r.reason),
    ["failed_call"],
  );
});
