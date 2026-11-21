import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildTopicInsights,
  type InsightsInput,
  type PlacedTurn,
} from "@/lib/readings/topics/stats";
import { turn } from "@/lib/readings/topics/test-fixtures";

const END = new Date("2026-10-20T12:00:00Z");
const DAY = 86_400_000;
const MINUTE = 60_000;

function placed(over: Partial<PlacedTurn> & { turn: PlacedTurn["turn"] }): PlacedTurn {
  return {
    verdict: "topic",
    topicId: "t_pay",
    source: "user",
    askHash: null,
    sentiment: null,
    retryOf: null,
    ...over,
  };
}

function input(rows: PlacedTurn[], over: Partial<InsightsInput> = {}): InsightsInput {
  return {
    placed: rows,
    topicIds: ["t_pay", "t_delivery"],
    window: {
      start: new Date(END.getTime() - 30 * DAY),
      end: END,
      readFrom: new Date(END.getTime() - 30 * DAY),
      capped: false,
    },
    selfCorrections: null,
    sessionsTrusted: true,
    naming: "model",
    placement: "judged",
    namingHash: "abc",
    ...over,
  };
}

test("a topic counts its turns per day, what was answered, its tasks, tools and examples", () => {
  const today = turn({
    at: END.getTime() - 2 * 3_600_000,
    workflowId: "wf_a",
    calls: [{ tool: "get_payment", outcome: "ok" }],
  });
  const yesterday = turn({
    at: END.getTime() - DAY - 60_000,
    workflowId: "wf_a",
    calls: [{ tool: "get_payment", outcome: "error" }],
    sessionId: "s2",
  });
  const old = turn({ at: END.getTime() - 29 * DAY, workflowId: null, calls: [], sessionId: "s3" });
  const insights = buildTopicInsights(
    input([
      placed({ turn: today, askHash: "h1", sentiment: "negative" }),
      placed({ turn: yesterday, askHash: "h1", sentiment: "neutral" }),
      placed({ turn: old, askHash: "h2", source: "search" }),
    ]),
  );
  const pay = insights.topics[0]!;
  assert.equal(pay.id, "t_pay");
  assert.equal(pay.turns, 3);
  assert.equal(pay.asks, 2);
  assert.equal(pay.daily.length, 30);
  assert.equal(pay.daily[29], 1, "today is the last day");
  assert.equal(pay.daily[28], 1);
  assert.equal(pay.daily[0], 1);
  assert.equal(pay.answered, 1, "a failed last call and no call at all are unanswered");
  assert.deepEqual(
    pay.sentiment,
    { positive: 0, neutral: 1, negative: 1 },
    "only turns read for sentiment",
  );
  assert.deepEqual(pay.tasks, [{ id: "wf_a", turns: 2 }]);
  assert.equal(pay.untasked, 1);
  assert.deepEqual(pay.tools, [{ id: "get_payment", calls: 2, failures: 1 }]);
  assert.deepEqual(
    pay.examples,
    [today.id, old.id],
    "one per distinct ask, users' own words first",
  );
  assert.equal(pay.selfCorrections, null, "none recorded for the window");
  assert.deepEqual(insights.tools, [{ id: "get_payment", calls: 2, failures: 1, task: "wf_a" }]);
});

test("sentiment is null when no turn carried the user's own words", () => {
  const insights = buildTopicInsights(
    input([placed({ turn: turn({ at: END.getTime() - DAY }), source: "search" })]),
  );
  assert.equal(insights.topics[0]!.sentiment, null);
  assert.equal(insights.sentimentMeasured, 0);
});

test("retries count against the topic asked again, and flows follow each conversation", () => {
  const first = turn({ at: END.getTime() - DAY, sessionId: "c1" });
  const again = turn({ at: END.getTime() - DAY + 2 * MINUTE, sessionId: "c1" });
  const then = turn({ at: END.getTime() - DAY + 4 * MINUTE, sessionId: "c1" });
  const insights = buildTopicInsights(
    input([
      placed({ turn: first }),
      placed({ turn: again, verdict: "retry", topicId: null, retryOf: first.id }),
      placed({ turn: then, topicId: "t_delivery" }),
    ]),
  );
  const pay = insights.topics.find((t) => t.id === "t_pay")!;
  assert.equal(pay.askedAgain, 1);
  assert.deepEqual(pay.next, [{ key: "retry", sessions: 1 }]);
  assert.deepEqual(insights.verdicts, { topic: 2, retry: 1, none: 0, no_ask: 0 });
  assert.deepEqual(
    insights.flows!.all.columns.map((c) => c.nodes.map((node) => node.key)),
    [["t_pay"], ["retry"], ["t_delivery"]],
  );
  assert.deepEqual(insights.flows!.starts, ["t_pay"]);
});

test("without trusted sessions there are no flows and nothing came next", () => {
  const insights = buildTopicInsights(
    input([placed({ turn: turn({ at: END.getTime() - DAY }) })], { sessionsTrusted: false }),
  );
  assert.equal(insights.flows, null);
  assert.equal(insights.flowsBlocked, "sessions_mixed");
  assert.deepEqual(insights.topics[0]!.next, []);
});

test("self-corrections are counted per topic once any were recorded", () => {
  const a = turn({ at: END.getTime() - DAY });
  const b = turn({ at: END.getTime() - DAY, sessionId: "s9" });
  const insights = buildTopicInsights(
    input([placed({ turn: a }), placed({ turn: b })], {
      selfCorrections: new Map([[a.id, ["retry_after_error", "phrase"]]]),
    }),
  );
  assert.deepEqual(insights.topics[0]!.selfCorrections, {
    events: 2,
    turns: 1,
    byKind: { retry_after_error: 1, phrase: 1 },
  });
});

test("the totals: sources, verdicts, unplaced turns", () => {
  const rows = [
    placed({ turn: turn({ at: END.getTime() - DAY }), source: "prompt" }),
    placed({
      turn: turn({ at: END.getTime() - DAY, sessionId: "x" }),
      verdict: "none",
      topicId: null,
      source: "search",
    }),
    placed({
      turn: turn({ at: END.getTime() - DAY, sessionId: "y", calls: [] }),
      verdict: "no_ask",
      topicId: null,
      source: null,
    }),
  ];
  const insights = buildTopicInsights(input(rows));
  assert.equal(insights.turns, 3);
  assert.deepEqual(insights.sources, { user: 0, prompt: 1, search: 1, none: 1 });
  assert.deepEqual(insights.unplaced, { turns: 1, answered: 1 });
  assert.equal(insights.version, 1);
  assert.equal(insights.namingHash, "abc");
});

test("a turn with no ask text steps through Flows as the task the agent ran; with no call either, Other", () => {
  const first = turn({ at: END.getTime() - DAY, sessionId: "c9" });
  const silent = {
    ...turn({ at: END.getTime() - DAY + 2 * MINUTE, sessionId: "c9" }),
    workflowId: "wf_track",
  };
  const unknown = { ...turn({ at: END.getTime() - DAY + 4 * MINUTE, sessionId: "c9" }), calls: [] };
  const insights = buildTopicInsights(
    input([
      placed({ turn: first }),
      placed({ turn: silent, verdict: "no_ask", topicId: null }),
      placed({ turn: unknown, verdict: "no_ask", topicId: null }),
    ]),
  );
  assert.deepEqual(
    insights.flows!.all.columns.map((c) => c.nodes.map((node) => node.key)),
    [["t_pay"], ["task:wf_track"], ["other"]],
  );
  assert.deepEqual(insights.topics.find((t) => t.id === "t_pay")!.next, [
    { key: "task:wf_track", sessions: 1 },
  ]);
});

test("a turn with no ask text and no task steps through Flows as the tool it called", () => {
  const first = {
    ...turn({ at: END.getTime() - 2 * DAY, sessionId: "c10" }),
    calls: [{ tool: "update_task", outcome: "ok" as const }],
  };
  const second = {
    ...turn({ at: END.getTime() - 2 * DAY + 2 * MINUTE, sessionId: "c10" }),
    calls: [
      { tool: "add_task_comment", outcome: "error" as const },
      { tool: "add_task_comment", outcome: "ok" as const },
    ],
  };
  const silent = {
    ...turn({ at: END.getTime() - 2 * DAY + 4 * MINUTE, sessionId: "c10" }),
    calls: [],
  };
  const insights = buildTopicInsights(
    input([
      placed({ turn: first, verdict: "no_ask", topicId: null }),
      placed({ turn: second, verdict: "no_ask", topicId: null }),
      placed({ turn: silent, verdict: "no_ask", topicId: null }),
    ]),
  );
  assert.deepEqual(
    insights.flows!.all.columns.map((c) => c.nodes.map((node) => node.key)),
    [["tool:update_task"], ["tool:add_task_comment"], ["other"]],
  );
});

test("an intent counts the conversations its asks were in; without trusted sessions it counts none", () => {
  const a1 = turn({ at: END.getTime() - DAY, sessionId: "c1" });
  const a2 = turn({ at: END.getTime() - DAY + 2 * MINUTE, sessionId: "c1" });
  const b1 = turn({ at: END.getTime() - DAY, sessionId: "c2" });
  const b2 = turn({ at: END.getTime() - DAY + 2 * MINUTE, sessionId: "c2" });
  const rows = [
    placed({ turn: a1 }),
    placed({ turn: a2 }),
    placed({ turn: b1 }),
    placed({ turn: b2, topicId: "t_delivery" }),
  ];
  const insights = buildTopicInsights(input(rows));
  const byId = new Map(insights.topics.map((topic) => [topic.id, topic]));
  assert.equal(byId.get("t_pay")!.turns, 3);
  assert.equal(byId.get("t_pay")!.conversations, 2, "three asks in two conversations");
  assert.equal(byId.get("t_delivery")!.conversations, 1);
  const untrusted = buildTopicInsights(input(rows, { sessionsTrusted: false }));
  assert.equal("conversations" in untrusted.topics[0]!, false, "no conversations to count");
});

test("the reading keeps which lanes its turns came by, and telemetry turns with no conversation id", () => {
  const sdk = turn({ at: END.getTime() - DAY, sessionId: "sdk-session" });
  const otel = {
    ...turn({ at: END.getTime() - DAY, sessionId: "conv-7" }),
    turnSource: "otlp" as const,
    traceId: "trace-a",
  };
  const lone = {
    ...turn({ at: END.getTime() - DAY, sessionId: "trace-b" }),
    turnSource: "otlp" as const,
    traceId: "trace-b",
  };
  const modelOnly = {
    ...turn({ at: END.getTime() - DAY, sessionId: "trace:trace-c" }),
    id: "trace:trace-c",
    turnSource: "otlp" as const,
    traceId: "trace-c",
    calls: [],
  };
  const insights = buildTopicInsights(
    input([sdk, otel, lone, modelOnly].map((t) => placed({ turn: t }))),
  );
  assert.deepEqual(insights.lanes, { telemetry: 3, sdk: 1, telemetryWithoutConversation: 2 });
});

test("sentiment says how it was read: by the model on some asks, by the keyword list on the rest", () => {
  const rows = [
    placed({
      turn: turn({ at: END.getTime() - DAY, sessionId: "m1" }),
      sentiment: "negative",
      sentimentByModel: true,
    }),
    placed({
      turn: turn({ at: END.getTime() - DAY, sessionId: "m2" }),
      sentiment: "neutral",
      sentimentByModel: true,
    }),
    placed({ turn: turn({ at: END.getTime() - DAY, sessionId: "m3" }), sentiment: "positive" }),
    placed({ turn: turn({ at: END.getTime() - DAY, sessionId: "m4" }), source: "search" }),
  ];
  const insights = buildTopicInsights(input(rows));
  assert.equal(insights.sentimentMeasured, 3);
  assert.deepEqual(insights.sentimentRead, { model: 2, words: 1 });
});

test("sessions whose asks overlap hold several people at once: no flows, nothing next, no conversations", () => {
  // One session, twelve asks ten seconds apart, each thirty seconds long: nobody asks over their own answer.
  const rows = Array.from({ length: 12 }, (_, index) =>
    placed({
      turn: turn({ at: END.getTime() - DAY + index * 10_000, sessionId: "shared", minutes: 0.5 }),
    }),
  );
  const insights = buildTopicInsights(input(rows));
  assert.equal(insights.flows, null);
  assert.equal(insights.flowsBlocked, "sessions_mixed");
  assert.deepEqual(insights.topics[0]!.next, []);
  assert.equal("conversations" in insights.topics[0]!, false);
});
