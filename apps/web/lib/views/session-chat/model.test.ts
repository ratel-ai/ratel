import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSessionTimeline,
  type TimelineLedgerStep,
  type TimelineModelCall,
  type TimelineSelfCorrection,
  type TimelineTurn,
} from "@/lib/views/session-replay/timeline";
import {
  buildSessionChat,
  type ChatCallText,
  formatDuration,
  formatStepTime,
  MIN_SEGMENT_MS,
  WAIT_TRACK_MS,
} from "./model";

/** RC-281: the session chat model, built from in-memory inputs only. */

const T0 = Date.parse("2026-10-20T10:00:00Z");
const at = (ms: number) => new Date(T0 + ms);

function turn(
  id: string,
  startMs: number,
  endMs: number,
  steps: TimelineLedgerStep[],
  extra: Partial<TimelineTurn> = {},
): TimelineTurn {
  return {
    id,
    startedAt: at(startMs),
    endedAt: at(endMs),
    endedBy: "next_turn",
    abandoned: false,
    detour: false,
    reSearchCount: 0,
    steps,
    ...extra,
  };
}

function search(ordinal: number, ms: number, tookMs: number | null): TimelineLedgerStep {
  return {
    ordinal,
    kind: "search",
    traceEventId: `ev-${ordinal}-${ms}`,
    occurredAt: at(ms),
    eventPresent: true,
    targetType: null,
    targetId: null,
    outcome: null,
    tookMs,
    searchType: "search",
    hitCount: 2,
    hitIds: ["a", "b"],
  };
}

function invoke(
  ordinal: number,
  ms: number,
  targetId: string,
  tookMs: number | null,
  outcome = "ok",
): TimelineLedgerStep {
  return {
    ordinal,
    kind: "invoke",
    traceEventId: `ev-${ordinal}-${ms}`,
    occurredAt: at(ms),
    eventPresent: true,
    targetType: "tool",
    targetId,
    outcome,
    tookMs,
    searchType: null,
    hitCount: null,
    hitIds: null,
  };
}

function call(
  eventId: string,
  turnId: string,
  ms: number,
  latencyMs: number | null,
): TimelineModelCall {
  return {
    eventId,
    turnId,
    occurredAt: at(ms),
    model: "claude-opus-5-5",
    finishReason: "tool_use",
    inputTokens: 1000,
    outputTokens: 40,
    cachedTokens: 0,
    costUsd: 0.01,
    latencyMs,
    hasContent: true,
  };
}

function chat(
  turns: TimelineTurn[],
  calls: TimelineModelCall[],
  texts: Map<string, ChatCallText> | null,
  selfCorrections: TimelineSelfCorrection[] = [],
) {
  const timeline = buildSessionTimeline({
    sessionId: "s1",
    turns,
    modelCalls: calls,
    selfCorrections,
  });
  return buildSessionChat({ timeline, turns, texts });
}

/** Turn 1: ask at 0, model 0.5–1.5 s, search 2–2.4 s, model 2.5–4 s, tool 4.2–4.8 s, ends at 5 s. */
function oneTurn() {
  return {
    turns: [turn("t1", 0, 5_000, [search(1, 2_000, 400), invoke(2, 4_200, "search_flights", 600)])],
    calls: [call("c1", "t1", 500, 1_000), call("c2", "t1", 2_500, 1_500)],
    texts: new Map<string, ChatCallText>([
      ["c1", { ask: "Book me a flight to Lisbon", reply: "Searching." }],
      ["c2", { ask: "Book me a flight to Lisbon", reply: "Found 3 flights." }],
    ]),
  };
}

test("one turn: the ask, the reply, the work line and segments as wide as their duration", () => {
  const { turns, calls, texts } = oneTurn();
  const model = chat(turns, calls, texts);
  assert.equal(model.textOff, false);
  assert.equal(model.turns.length, 1);
  const [t] = model.turns;
  assert.equal(t.ask, "Book me a flight to Lisbon");
  assert.equal(t.reply, "Found 3 flights.");
  assert.deepEqual(t.work, { actions: 2, tookMs: 5_000, problems: 0, label: "2 actions · 5 s" });
  assert.deepEqual(t.split, { thinkingMs: 2_500, toolMs: 600, searchMs: 400 });
  assert.deepEqual([t.inputTokens, t.outputTokens, t.costUsd], [2_000, 80, 0.02]);
  assert.deepEqual(
    model.segments.map((s) => [s.kind, s.label, s.trackStartMs, s.trackMs, s.realMs, s.measured]),
    [
      ["ask", "Ask", 0, MIN_SEGMENT_MS, 0, true],
      ["model_call", "claude-opus-5-5", 800, 1_000, 1_000, true],
      ["search", "Search", 2_300, 400, 400, true],
      ["model_call", "claude-opus-5-5", 2_800, 1_500, 1_500, true],
      ["tool_call", "search_flights", 4_500, 600, 600, true],
    ],
  );
  assert.equal(model.trackTotalMs, 5_300);
  assert.equal(model.realTotalMs, 5_000);
  assert.deepEqual([t.trackStartMs, t.trackEndMs], [0, 5_300]);
  assert.deepEqual(model.problems, []);
  assert.deepEqual(
    model.calls.map((c) => [c.callNumber, c.stepIndex, c.eventId, c.inputTokens, c.latencyMs]),
    [
      [1, 2, "c1", 1_000, 1_000],
      [2, 4, "c2", 1_000, 1_500],
    ],
  );
});

test("multi-turn: a long wait between turns collapses to a fixed width with its real time", () => {
  const { turns, calls, texts } = oneTurn();
  turns.push(turn("t2", 300_000, 302_000, [invoke(1, 300_500, "book_flight", 1_000)]));
  texts.set("c3", { ask: "Take the cheapest", reply: "Booked." });
  const model = chat(turns, [...calls, call("c3", "t2", 301_600, 300)], texts);
  const wait = model.segments.find((s) => s.kind === "wait");
  assert.ok(wait);
  assert.equal(wait.label, "5 min later");
  assert.equal(wait.realMs, 295_000);
  assert.equal(wait.trackMs, WAIT_TRACK_MS);
  assert.equal(wait.trackStartMs, 5_300);
  assert.deepEqual(
    model.turns.map((t) => [t.turnIndex, t.ask, t.reply, t.work.label]),
    [
      [1, "Book me a flight to Lisbon", "Found 3 flights.", "2 actions · 5 s"],
      [2, "Take the cheapest", "Booked.", "1 action · 2 s"],
    ],
  );
  assert.equal(model.turns[1].trackStartMs, 5_300 + WAIT_TRACK_MS);
  assert.equal(model.realTotalMs, 302_000);
});

test("a short pause stays at its real width", () => {
  const turns = [turn("t1", 0, 1_000, []), turn("t2", 11_000, 12_000, [])];
  const model = chat(turns, [], null);
  assert.equal(
    model.segments.some((s) => s.kind === "wait"),
    false,
  );
  assert.equal(model.turns[1].trackStartMs, MIN_SEGMENT_MS + 11_000);
  assert.equal(model.turns[0].work.label, "No actions · 1 s");
});

test("problems: a failed tool call, a retry and an abandoned turn are counted and listed", () => {
  const turns = [
    turn(
      "t1",
      0,
      10_000,
      [
        invoke(1, 1_000, "get_fare", 200, "error"),
        invoke(2, 2_000, "get_fare", 200, "ok"),
        invoke(3, 3_000, "quote", 100),
      ],
      { abandoned: true },
    ),
  ];
  const model = chat(turns, [], null);
  assert.deepEqual(model.turns[0].work, {
    actions: 3,
    tookMs: 10_000,
    problems: 3,
    label: "3 actions · 10 s · 3 to check",
  });
  assert.deepEqual(
    model.problems.map((p) => [p.stepIndex, p.kinds]),
    [
      [1, ["abandoned"]],
      [2, ["failed"]],
      [3, ["retry"]],
    ],
  );
  assert.deepEqual(
    model.segments.filter((s) => s.problem).map((s) => s.stepIndex),
    [1, 2, 3],
  );
  assert.equal(
    model.problems[1].trackStartMs,
    model.segments.find((s) => s.stepIndex === 2)!.trackStartMs,
  );
});

test("a self-correction marks its step as a problem", () => {
  const turns = [turn("t1", 0, 5_000, [search(1, 1_000, 100), search(2, 2_000, 100)])];
  const model = chat(turns, [], null, [{ turnId: "t1", kind: "searched_again", stepOrdinal: 2 }]);
  assert.deepEqual(
    model.problems.map((p) => [p.stepIndex, p.kinds]),
    [[3, ["loop"]]],
  );
});

test("a turn whose calls end after its recorded end takes until its last step", () => {
  const turns = [turn("t1", 0, 500, [])];
  const model = chat(turns, [call("c1", "t1", 200, 3_000)], null);
  assert.equal(model.turns[0].work.tookMs, 3_200);
  assert.equal(model.turns[0].work.label, "No actions · 3 s");
  assert.equal(model.realTotalMs, 3_200);
});

test("missing durations: a minimum width marked not measured", () => {
  const turns = [turn("t1", 0, 3_000, [search(1, 1_000, null), invoke(2, 2_000, "quote", null)])];
  const model = chat(turns, [call("c1", "t1", 500, null)], null);
  const steps = model.segments.filter((s) => s.kind !== "ask");
  assert.deepEqual(
    steps.map((s) => [s.kind, s.trackMs, s.realMs, s.measured]),
    [
      ["model_call", MIN_SEGMENT_MS, null, false],
      ["search", MIN_SEGMENT_MS, null, false],
      ["tool_call", MIN_SEGMENT_MS, null, false],
    ],
  );
});

test("steps that overlap are laid one after the other", () => {
  const turns = [turn("t1", 0, 2_000, [invoke(1, 600, "quote", 300)])];
  const model = chat(turns, [call("c1", "t1", 0, 1_000)], null);
  const [, modelCall, tool] = model.segments;
  assert.equal(tool.trackStartMs, modelCall.trackStartMs + modelCall.trackMs);
});

test("text off: the chat keeps its turns and work lines with no words", () => {
  const { turns, calls } = oneTurn();
  const model = chat(turns, calls, null);
  assert.equal(model.textOff, true);
  assert.deepEqual(
    model.turns.map((t) => [t.ask, t.reply, t.work.label]),
    [[null, null, "2 actions · 5 s"]],
  );
});

test("a turn takes its ask from its first call with one and its reply from its last", () => {
  const { turns, calls } = oneTurn();
  const texts = new Map<string, ChatCallText>([
    ["c1", { ask: "First ask", reply: null }],
    ["c2", { ask: null, reply: null }],
  ]);
  const [t] = chat(turns, calls, texts).turns;
  assert.equal(t.ask, "First ask");
  assert.equal(t.reply, null);
});

test("formatStepTime", () => {
  assert.equal(formatStepTime(154), "154 ms");
  assert.equal(formatStepTime(2_340), "2.3 s");
  assert.equal(formatStepTime(11_400), "11 s");
});

test("formatDuration", () => {
  assert.equal(formatDuration(400), "<1 s");
  assert.equal(formatDuration(11_400), "11 s");
  assert.equal(formatDuration(65_000), "1 min 5 s");
  assert.equal(formatDuration(120_000), "2 min");
  assert.equal(formatDuration(3_900_000), "1 h 5 min");
});
