import assert from "node:assert/strict";
import { test } from "node:test";
import type { StoredFailureStreak } from "@/lib/readings/trace-signals/outcomes/kinds";
import { sentimentLinks, weekLabel } from "@/lib/views/traces/sentiment/page-links";
import {
  buildSentimentPage,
  OTHER_INTENTS,
  type PageTurn,
  type SentimentPageInput,
} from "@/lib/views/traces/sentiment/page-model";
import {
  DEFAULT_SENTIMENT_QUERY,
  NO_SENTIMENT_FILTERS,
  type SentimentQuery,
} from "@/lib/views/traces/sentiment/page-paths";

const NOW = new Date("2026-09-02T00:00:00Z");
const BASE = "/project/p1/traces/sentiment";

const streak = (tool: string, over: Partial<StoredFailureStreak> = {}): StoredFailureStreak => ({
  tool,
  ordinal: 1,
  errors: 1,
  cause: "bad_arguments",
  followed: "fixed_next_try",
  recovered: true,
  ...over,
});

function turn(sessionId: string, tool: string): PageTurn {
  return {
    turnId: `t-${sessionId}-${tool}`,
    sessionId,
    startedAt: new Date("2026-09-01T09:59:00Z"),
    endedAt: new Date("2026-09-01T10:00:00Z"),
    costUsd: null,
    cause: null,
    causeSource: null,
    failures: [streak(tool)],
    unmetSearches: 0,
    satisfaction: null,
    reaction: null,
  };
}

function page(query: Partial<SentimentQuery> = {}) {
  const turns = [
    ...["a", "b", "c"].map((id) => turn(id, "skill:report")),
    ...["d", "e", "f"].map((id) => turn(id, "update_task")),
    turn("g", "archive_board"),
  ];
  const input: SentimentPageInput = {
    projectId: "p1",
    windowDays: 30,
    now: NOW,
    turns,
    sessions: [],
    intents: new Map(
      turns.slice(3, 6).map((t) => [t.turnId, { id: "i-1", label: "Update a task" }]),
    ),
    versions: new Map(turns.map((t) => [t.turnId, "v2"])),
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
  };
  return buildSentimentPage(input, { ...DEFAULT_SENTIMENT_QUERY, ...query });
}

test("a row links to the page narrowed to its intent, cause and tool, to its tool in Catalog and to its examples' traces", () => {
  const links = sentimentLinks(page());
  const row = links.rows.find((r) => r.tool === "update_task")!;
  assert.equal(row.intentHref, `${BASE}?intent=i-1`);
  assert.equal(row.causeHref, `${BASE}?cause=bad_arguments`);
  assert.equal(row.toolHref, `${BASE}?tool=update_task`);
  assert.deepEqual([row.toolName, row.toolKind], ["update_task", "tool"]);
  assert.ok(row.catalogHref?.startsWith("/project/p1/catalogs"));
  assert.equal(row.exampleHrefs.length, 3);
  assert.match(row.exampleHrefs[0]!, /^\/project\/p1\/traces\/turns\/t-[def]-update_task$/);

  const skill = links.rows.find((r) => r.tool === "skill:report")!;
  assert.deepEqual([skill.toolName, skill.toolKind], ["report", "skill"]);
  assert.equal(
    skill.intentHref,
    `${BASE}?intent=none`,
    "a row with no intent narrows to turns placed nowhere",
  );
});

test("a folded row has no one intent to narrow to", () => {
  const model = page();
  const folded = { ...model.rows[0]!, intent: OTHER_INTENTS };
  const links = sentimentLinks({ ...model, rows: [folded] });
  assert.equal(links.rows[0]?.intentHref, null);
});

test("filters read as chips that remove themselves, and every link keeps the window, the sort and the other filters", () => {
  const filters = { ...NO_SENTIMENT_FILTERS, intent: "i-1", week: "2026-08-31" };
  const links = sentimentLinks({ ...page({ filters, sort: "share" }), windowDays: 90 });
  assert.deepEqual(links.filters, [
    {
      field: "intent",
      label: "Intent",
      value: "Update a task",
      removeHref: `${BASE}?days=90&week=2026-08-31&sort=share`,
    },
    {
      field: "week",
      label: "Week of",
      value: "Aug 31",
      removeHref: `${BASE}?days=90&intent=i-1&sort=share`,
    },
  ]);
  assert.equal(links.clearHref, `${BASE}?days=90&sort=share`);
  assert.equal(links.thinHref, `${BASE}?days=90&intent=i-1&week=2026-08-31&sort=share&thin=1`);
  assert.equal(
    links.sortHrefs.sessions,
    `${BASE}?days=90&intent=i-1&week=2026-08-31&sort=sessions`,
  );
  assert.equal(
    links.sortHrefs.impact,
    `${BASE}?days=90&intent=i-1&week=2026-08-31`,
    "the default sort is left out",
  );
});

test("a cut's value narrows the page to it, and the active one removes its filter", () => {
  const links = sentimentLinks(page({ filters: { ...NO_SENTIMENT_FILTERS, tool: "update_task" } }));
  const tools = Object.fromEntries(links.cuts.tool.values.map((value) => [value.key, value.href]));
  assert.equal(tools.update_task, BASE, "the active tool removes the filter");
  assert.equal(tools["skill:report"], `${BASE}?tool=skill%3Areport`);
  assert.equal(links.cuts.version.values[0]?.href, `${BASE}?tool=update_task&version=v2`);
  assert.equal(
    sentimentLinks(page({ thin: true })).thinHref,
    BASE,
    "showing thin rows links back to hiding them",
  );
});

test("a week reads by the Monday it starts on", () => {
  assert.equal(weekLabel("2026-08-31"), "Aug 31");
  assert.equal(weekLabel("not a date"), "not a date");
});

test("the pager links keep the window, sort and filters; a new sort or filter starts on the first page", () => {
  const turns = Array.from({ length: 25 }, (_, i) =>
    ["a", "b", "c"].map((s) => turn(`${s}${i}`, `tool_${String(i).padStart(2, "0")}`)),
  ).flat();
  const input: SentimentPageInput = {
    projectId: "p1",
    windowDays: 90,
    now: NOW,
    turns,
    sessions: [],
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
  };
  const second = sentimentLinks(
    buildSentimentPage(input, { ...DEFAULT_SENTIMENT_QUERY, sort: "time", page: 2 }),
  );
  assert.equal(second.prevHref, `${BASE}?days=90&sort=time`);
  assert.equal(second.nextHref, null);
  assert.equal(second.sortHrefs.sessions, `${BASE}?days=90&sort=sessions`);
  assert.equal(second.groups[0]?.causeHref, `${BASE}?days=90&cause=bad_arguments&sort=time`);
  const first = sentimentLinks(
    buildSentimentPage(input, { ...DEFAULT_SENTIMENT_QUERY, sort: "time" }),
  );
  assert.deepEqual([first.prevHref, first.nextHref], [null, `${BASE}?days=90&sort=time&page=2`]);
});

test("how sessions ended is a choice above the root causes, a chip, and part of every other link", () => {
  const model = page({ filters: { ...NO_SENTIMENT_FILTERS, outcome: "blocked" } });
  const links = sentimentLinks(model);
  assert.deepEqual(
    links.ended.map((choice) => [choice.outcome, choice.active, choice.href]),
    [
      [null, false, BASE],
      ["resolved_clean", false, `${BASE}?ended=resolved_clean`],
      ["resolved_after_friction", false, `${BASE}?ended=resolved_after_friction`],
      ["gave_up", false, `${BASE}?ended=gave_up`],
      ["blocked", true, `${BASE}?ended=blocked`],
      ["escalated", false, `${BASE}?ended=escalated`],
    ],
  );
  assert.deepEqual(links.filters, [
    { field: "outcome", label: "Sessions that ended", value: "Blocked", removeHref: BASE },
  ]);
  assert.equal(links.sortHrefs.time, `${BASE}?ended=blocked&sort=time`);
});

test("a task result and a task reason are choices that narrow the page, and a reason sets not completed with it", () => {
  const model = page({
    filters: { ...NO_SENTIMENT_FILTERS, task: "not_completed", reason: "no_tool" },
  });
  const withTasks = {
    ...model,
    tasks: { ...model.tasks, reasons: [{ reason: "no_tool" as const, tasks: 2, share: 1 }] },
  };
  const links = sentimentLinks(withTasks);
  assert.equal(
    links.taskClasses.find((c) => c.key === "completed")?.href,
    `${BASE}?task=completed`,
  );
  assert.equal(
    links.taskClasses.find((c) => c.key === "not_completed")?.active,
    false,
    "a reason is picked, not the result alone",
  );
  assert.deepEqual(
    links.taskReasons.map((r) => [r.key, r.active, r.href]),
    [["no_tool", true, BASE]],
  );
  assert.deepEqual(
    links.filters.map((f) => [f.field, f.value]),
    [
      ["task", "Not completed"],
      ["reason", "No fitting tool"],
    ],
  );
  const fresh = sentimentLinks({ ...page(), tasks: withTasks.tasks });
  assert.equal(fresh.taskReasons[0]?.href, `${BASE}?task=not_completed&why=no_tool`);
});

test("a task status and a reason group narrow the page; a friction reason sets its own result, and reads as a chip", () => {
  const model = page();
  const group = {
    key: "completed_after_friction:repeated",
    result: "completed_after_friction" as const,
    reason: "repeated" as const,
    tasks: 2,
    sessions: 2,
    costUsd: null,
    tokens: null,
    timeMs: 0,
    extraTurns: 1,
    lastSeen: null,
    moreRows: 0,
  };
  const example = {
    taskId: "t-1",
    sessionId: "s-1",
    turnIds: ["t-1", "t-2"],
    turnId: "t-2",
    endedAt: "2026-09-01T10:00:00.000Z",
    extraTurns: 1,
  };
  const row = {
    key: "bad_arguments|update_task",
    cause: "bad_arguments" as const,
    tool: "update_task",
    readBy: "rule" as const,
    tasks: 2,
    sessions: 2,
    costUsd: null,
    tokens: null,
    timeMs: 0,
    extraTurns: 1,
    lastSeen: null,
    avoidable: "agent" as const,
    examples: [example],
  };
  const links = sentimentLinks({
    ...model,
    overview: { ...model.overview, groups: [{ ...group, rows: [row] }] },
  });
  assert.equal(
    links.statuses.find((s) => s.filter === "not_completed")?.href,
    `${BASE}?task=not_completed`,
  );
  assert.deepEqual(
    links.reasonGroups.map((g) => [g.label, g.href, g.rows[0]?.causeHref, g.rows[0]?.toolHref]),
    [
      [
        "Person asked again",
        `${BASE}?task=completed_after_friction&why=repeated`,
        `${BASE}?cause=bad_arguments`,
        `${BASE}?tool=update_task`,
      ],
    ],
  );
  // Each turn of an example task opens in Traces.
  assert.deepEqual(links.reasonGroups[0]!.rows[0]!.examples[0]!.turnHrefs, [
    "/project/p1/traces/turns/t-1",
    "/project/p1/traces/turns/t-2",
  ]);
  assert.equal(
    links.reasonGroups[0]!.rows[0]!.examples[0]!.traceHref,
    "/project/p1/traces/turns/t-2",
    "the turn the cause happened in",
  );

  const narrowed = page({
    filters: { ...NO_SENTIMENT_FILTERS, task: "completed_after_friction", reason: "repeated" },
  });
  const active = sentimentLinks({
    ...narrowed,
    overview: { ...narrowed.overview, groups: [{ ...group, rows: [] }] },
  });
  assert.deepEqual(
    active.reasonGroups.map((g) => [g.active, g.href]),
    [[true, BASE]],
  );
  assert.deepEqual(
    active.filters.map((f) => [f.field, f.value]),
    [
      ["task", "Completed after friction"],
      ["reason", "Person asked again"],
    ],
  );
});

test("above the reasons table: every reason or one result, then that result's reasons; a picked reason lets go on a second pick", () => {
  const reasons = [
    { result: "not_completed" as const, reason: "failed_call" as const, tasks: 3 },
    { result: "completed_after_friction" as const, reason: "repeated" as const, tasks: 2 },
  ];
  const at = (query: Partial<SentimentQuery>) => {
    const model = page(query);
    return sentimentLinks({ ...model, overview: { ...model.overview, reasons } });
  };
  const all = at({});
  assert.deepEqual(
    all.reasonStatuses.map((s) => [s.key, s.tasks, s.active, s.href]),
    [
      ["all", 5, true, BASE],
      ["not_completed", 3, false, `${BASE}?task=not_completed`],
      ["completed_after_friction", 2, false, `${BASE}?task=completed_after_friction`],
    ],
  );
  assert.deepEqual(
    all.reasonChoices.map((r) => [r.label, r.href]),
    [
      ["Ended on a failed call", `${BASE}?task=not_completed&why=failed_call`],
      ["Person asked again", `${BASE}?task=completed_after_friction&why=repeated`],
    ],
  );
  const friction = at({
    filters: { ...NO_SENTIMENT_FILTERS, task: "completed_after_friction", reason: "repeated" },
  });
  assert.deepEqual(
    friction.reasonStatuses.map((s) => s.active),
    [false, false, true],
    "the result stays picked with one of its reasons",
  );
  assert.deepEqual(
    friction.reasonChoices.map((r) => [r.key, r.active, r.href]),
    [["completed_after_friction:repeated", true, `${BASE}?task=completed_after_friction`]],
  );
});
