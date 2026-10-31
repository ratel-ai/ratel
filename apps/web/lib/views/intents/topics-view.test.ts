import assert from "node:assert/strict";
import { test } from "node:test";
import type { StoredTopic, TopicInsights, TopicStats } from "@/lib/readings/topics/types";
import {
  buildTopicsView,
  conversationsReadable,
  nextLabel,
  parseTopicSort,
  sortTopics,
  toolCatalogHref,
  trendBuckets,
} from "@/lib/views/intents/topics-view";

const CREATED = new Date("2026-09-01T00:00:00Z");

function stored(topicId: string, name: string): StoredTopic {
  return {
    topicId,
    name,
    description: `${name} sentence.`,
    labelSource: "llm",
    model: "m",
    inputHash: "h",
    retiredAt: null,
    createdAt: CREATED,
  };
}

function stats(over: Partial<TopicStats> & { id: string }): TopicStats {
  return {
    turns: 10,
    asks: 4,
    daily: Array.from({ length: 30 }, () => 0),
    answered: 10,
    sentiment: null,
    tasks: [],
    untasked: 10,
    tools: [],
    selfCorrections: null,
    examples: [],
    askedAgain: 0,
    next: [],
    ...over,
  };
}

function insights(topics: TopicStats[], over: Partial<TopicInsights> = {}): TopicInsights {
  return {
    version: 1,
    windowDays: 30,
    windowStart: "2026-09-20T00:00:00.000Z",
    windowEnd: "2026-10-20T00:00:00.000Z",
    readFrom: "2026-09-20T00:00:00.000Z",
    capped: false,
    turns: 100,
    sources: { user: 80, prompt: 0, search: 20, none: 0 },
    verdicts: { topic: 70, retry: 3, none: 27, no_ask: 0 },
    sentimentMeasured: 0,
    naming: "model",
    placement: "judged",
    namingHash: null,
    topics,
    unplaced: { turns: 27, answered: 20 },
    tools: [],
    flows: null,
    flowsBlocked: "sessions_mixed",
    ...over,
  };
}

test("the trend is two-day buckets counted back from today", () => {
  const daily = Array.from({ length: 30 }, (_, i) => i);
  const buckets = trendBuckets(daily);
  assert.equal(buckets.length, 15);
  assert.equal(buckets.at(-1), 28 + 29);
  assert.equal(buckets[0], 0 + 1);
  assert.deepEqual(trendBuckets([1, 2, 3]), [1, 5], "an odd day out is the oldest bucket");
});

test("an intent row carries its numbers, its tasks with their colors and names, and its links by id", () => {
  const view = buildTopicsView({
    projectId: "p1",
    insights: insights(
      [
        stats({
          id: "t_pay",
          turns: 40,
          answered: 10,
          sentiment: { positive: 2, neutral: 10, negative: 8 },
          tasks: [
            { id: "wf_b", turns: 30 },
            { id: "wf_z", turns: 5 },
          ],
          untasked: 5,
          tools: [{ id: "get_payment", calls: 50, failures: 10 }],
          selfCorrections: { events: 5, turns: 4, byKind: { retry_after_error: 3, phrase: 2 } },
          next: [
            { key: "ended", sessions: 6 },
            { key: "t_delivery", sessions: 3 },
            { key: "retry", sessions: 1 },
          ],
          askedAgain: 2,
        }),
        stats({ id: "t_delivery", turns: 30 }),
      ],
      {
        sentimentMeasured: 20,
        flows: {
          all: { sessions: 0, multiTurn: 0, wentOn: 0, columns: [] },
          starts: ["t_pay"],
          byStart: {},
        },
      },
    ),
    topics: [stored("t_pay", "Payment status"), stored("t_delivery", "Material delivery")],
    tasks: [
      { id: "wf_a", runs: 100, typicalOrder: ["a"] },
      { id: "wf_b", runs: 50, typicalOrder: ["find_payment", "get_payment"] },
      { id: "wf_c", runs: 20, typicalOrder: ["c"] },
      { id: "wf_z", runs: 1, typicalOrder: ["z"] },
    ],
    taskLabels: new Map([["wf_b", { name: "Check a payment" }]]),
  });
  const pay = view.topics[0]!;
  assert.equal(pay.name, "Payment status");
  assert.equal(pay.share, 0.4);
  assert.equal(pay.answeredShare, 0.25);
  assert.equal(pay.mostlyUnanswered, true);
  assert.deepEqual(pay.sentiment, {
    positive: 2,
    neutral: 10,
    negative: 8,
    measured: 20,
    negativeShare: 0.4,
  });
  assert.deepEqual(
    pay.tasks.map((t) => [t.name, t.slot, t.share, t.href]),
    [
      ["Check a payment", "chart-5", 0.75, "/project/p1/health/tasks/wf_b"],
      ["z", null, 0.125, "/project/p1/health/tasks/wf_z"],
    ],
    "a fourth task is neutral",
  );
  assert.equal(pay.slot, "chart-5", "the main task's color");
  assert.deepEqual(pay.tools, [
    {
      id: "get_payment",
      calls: 50,
      failures: 10,
      failureShare: 0.2,
      href: "/project/p1/catalogs/tools?q=get_payment&highlight=get_payment",
    },
  ]);
  assert.deepEqual(
    pay.selfCorrections?.kinds.map((k) => [k.label, k.events]),
    [
      ["Retried", 3],
      ["Apologized", 2],
    ],
  );
  assert.deepEqual(
    pay.next.map((n) => [n.kind, n.label, n.sessions]),
    [
      ["ended", "Ended", 6],
      ["topic", "Material delivery", 3],
      ["retry", "Asked again", 1],
    ],
  );
  assert.deepEqual(pay.links, {
    selfCorrections: "/project/p1/health/self-corrections?topic=t_pay",
    fixes: "/project/p1/improvement/fixes?topic=t_pay",
    flows: "/project/p1/intents/flows?start=t_pay",
  });
  assert.equal(
    view.topics[1]!.links.flows,
    "/project/p1/intents/flows",
    "no view starts there: all flows",
  );
  assert.deepEqual(view.summary, {
    topics: 2,
    turns: 100,
    inTopic: 70,
    unanswered: 50,
    askedAgain: 3,
    unplaced: 27,
    noAsk: 0,
    tasks: 2,
    sentimentMeasured: true,
    sentimentRead: { measured: 20, of: 100, model: null },
    mostNegative: { id: "t_pay", name: "Payment status", negative: 8, measured: 20 },
  });
  assert.equal(pay.conversations, null, "a reading before conversations were counted");
  assert.deepEqual(view.taskSlots, { wf_b: "chart-5" }, "only the tasks drawn");
});

test("an intent counts the conversations its asks were in, only where conversations can be told apart", () => {
  const flows = {
    all: { sessions: 30, multiTurn: 9, wentOn: 0, columns: [] },
    starts: [],
    byStart: {},
  };
  const build = (over: Partial<TopicInsights>) =>
    buildTopicsView({
      projectId: "p1",
      insights: insights([stats({ id: "t_pay", turns: 40, conversations: 31 })], {
        flows,
        flowsBlocked: null,
        ...over,
      }),
      topics: [stored("t_pay", "Payment status")],
      tasks: [],
      taskLabels: new Map(),
    }).topics[0]!;
  assert.equal(build({}).conversations, 31);
  assert.equal(
    build({ lanes: { telemetry: 40, sdk: 0, telemetryWithoutConversation: 0 } }).conversations,
    31,
  );
  assert.equal(
    build({ lanes: { telemetry: 40, sdk: 0, telemetryWithoutConversation: 30 } }).conversations,
    null,
    "most runs carried no conversation id: every ask would be its own conversation",
  );
  assert.equal(
    build({ flows: null, flowsBlocked: "sessions_mixed" }).conversations,
    null,
    "sessions can't be trusted",
  );
  assert.equal(
    conversationsReadable({
      flows,
      lanes: { telemetry: 10, sdk: 10, telemetryWithoutConversation: 10 },
    }),
    true,
    "half is still readable",
  );
});

test("the summary says how sentiment was read: by a model, by the keyword list, over every ask", () => {
  const view = buildTopicsView({
    projectId: "p1",
    insights: insights([stats({ id: "t_pay" })], {
      sentimentMeasured: 60,
      sentimentRead: { model: 45, words: 15 },
    }),
    topics: [stored("t_pay", "Payment status")],
    tasks: [],
    taskLabels: new Map(),
  });
  assert.deepEqual(view.summary.sentimentRead, { measured: 60, of: 100, model: 45 });
});

test("a tool opens its Catalog row; a skill opens the Skills catalog", () => {
  assert.equal(
    toolCatalogHref("p1", "get_payment"),
    "/project/p1/catalogs/tools?q=get_payment&highlight=get_payment",
  );
  assert.equal(
    toolCatalogHref("p 1", "a b"),
    "/project/p%201/catalogs/tools?q=a%20b&highlight=a%20b",
  );
  assert.equal(toolCatalogHref("p1", "skill:billing"), "/project/p1/catalogs/skills");
});

test("a task that came next carries its color", () => {
  const view = buildTopicsView({
    projectId: "p1",
    insights: insights([
      stats({
        id: "t_pay",
        next: [
          { key: "task:wf_b", sessions: 3 },
          { key: "tool:lookup", sessions: 1 },
        ],
      }),
    ]),
    topics: [stored("t_pay", "Payment status")],
    tasks: [{ id: "wf_b", runs: 50, typicalOrder: ["find_payment"] }],
    taskLabels: new Map([["wf_b", { name: "Check a payment" }]]),
  });
  assert.deepEqual(
    view.topics[0]!.next.map((next) => [next.kind, next.label, next.href, next.slot]),
    [
      ["task", "Check a payment", "/project/p1/health/tasks/wf_b", "chart-1"],
      ["tool", "lookup", "/project/p1/catalogs/tools?q=lookup&highlight=lookup", null],
    ],
  );
});

test("a topic the reading counts but no stored row names is left out", () => {
  const view = buildTopicsView({
    projectId: "p1",
    insights: insights([stats({ id: "t_gone" })]),
    topics: [],
    tasks: [],
    taskLabels: new Map(),
  });
  assert.equal(view.topics.length, 0);
});

test("next steps read in plain words, and a retired topic reads as something else", () => {
  const names = new Map([["t_pay", "Payment status"]]);
  assert.deepEqual(nextLabel("other", names), { kind: "other", label: "Something else" });
  assert.deepEqual(nextLabel("t_gone", names), { kind: "other", label: "Something else" });
});

test("sorting: busiest first by default, least answered first, most negative first, by name", () => {
  const view = buildTopicsView({
    projectId: "p1",
    insights: insights([
      stats({
        id: "a",
        turns: 50,
        answered: 50,
        sentiment: { positive: 0, neutral: 9, negative: 1 },
      }),
      stats({ id: "b", turns: 20, answered: 5 }),
      stats({
        id: "c",
        turns: 30,
        answered: 20,
        sentiment: { positive: 0, neutral: 5, negative: 5 },
      }),
    ]),
    topics: [stored("a", "Zeta"), stored("b", "Alpha"), stored("c", "Mid")],
    tasks: [],
    taskLabels: new Map(),
  });
  const ids = (sort: string) => sortTopics(view.topics, parseTopicSort(sort)).map((t) => t.id);
  assert.deepEqual(ids("turns"), ["a", "c", "b"]);
  assert.deepEqual(ids("answered"), ["b", "c", "a"]);
  assert.deepEqual(ids("negative"), ["c", "a", "b"], "not measured last");
  assert.deepEqual(ids("name"), ["b", "c", "a"]);
  assert.deepEqual(ids("bogus"), ["a", "c", "b"]);
});
