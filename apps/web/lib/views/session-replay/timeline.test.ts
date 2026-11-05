import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSessionTimeline,
  type TimelineInput,
  type TimelineLedgerStep,
  type TimelineModelCall,
  type TimelineTurn,
} from "./timeline";

const T0 = Date.parse("2026-10-20T10:00:00Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000);

function turn(
  id: string,
  startS: number,
  steps: TimelineLedgerStep[],
  extra: Partial<TimelineTurn> = {},
): TimelineTurn {
  return {
    id,
    startedAt: at(startS),
    endedAt: at(startS + 60),
    endedBy: "next_turn",
    abandoned: false,
    detour: false,
    reSearchCount: 0,
    steps,
    ...extra,
  };
}

function invoke(
  ordinal: number,
  s: number,
  targetId: string,
  outcome: "ok" | "error" | "unknown" = "ok",
  eventPresent = true,
): TimelineLedgerStep {
  return {
    ordinal,
    kind: "invoke",
    traceEventId: `ev-${ordinal}-${s}`,
    occurredAt: at(s),
    eventPresent,
    targetType: "tool",
    targetId,
    outcome,
    tookMs: 5,
    searchType: null,
    hitCount: null,
    hitIds: null,
  };
}

function search(
  ordinal: number,
  s: number,
  hitIds: string[] = ["get_trace", "search_docs"],
  eventPresent = true,
): TimelineLedgerStep {
  return {
    ordinal,
    kind: "search",
    traceEventId: `ev-${ordinal}-${s}`,
    occurredAt: at(s),
    eventPresent,
    targetType: null,
    targetId: null,
    outcome: null,
    tookMs: null,
    searchType: "search",
    hitCount: hitIds.length,
    hitIds,
  };
}

function call(eventId: string, turnId: string, s: number, hasContent = false): TimelineModelCall {
  return {
    eventId,
    turnId,
    occurredAt: at(s),
    model: "claude-sonnet-5-5",
    finishReason: "tool_use",
    inputTokens: 1000,
    outputTokens: 50,
    cachedTokens: 0,
    costUsd: 0.01,
    latencyMs: 900,
    hasContent,
  };
}

function input(
  turns: TimelineTurn[],
  modelCalls: TimelineModelCall[] = [],
  selfCorrections: TimelineInput["selfCorrections"] = [],
): TimelineInput {
  return { sessionId: "sess-1", turns, modelCalls, selfCorrections };
}

test("orders user turn → model call → searches and tool calls → next turn, numbering steps from 1", () => {
  const timeline = buildSessionTimeline(
    input(
      [
        turn("t2", 100, [invoke(1, 105, "get_trace")]),
        turn("t1", 0, [search(1, 3), invoke(2, 4, "search_docs")]),
      ],
      [call("e3", "t2", 104), call("e1", "t1", 1), call("e2", "t1", 3.5)],
    ),
  );
  assert.deepEqual(
    timeline.steps.map((step) => [step.index, step.kind, step.turnIndex]),
    [
      [1, "turn", 1],
      [2, "model_call", 1],
      [3, "search", 1],
      [4, "model_call", 1],
      [5, "tool_call", 1],
      [6, "turn", 2],
      [7, "model_call", 2],
      [8, "tool_call", 2],
    ],
  );
  assert.equal(timeline.turnCount, 2);
});

test("a model call at the same instant as a tool call comes first: it decided the call", () => {
  const timeline = buildSessionTimeline(
    input([turn("t1", 0, [invoke(1, 5, "get_trace")])], [call("e1", "t1", 5)]),
  );
  assert.deepEqual(
    timeline.steps.map((step) => step.kind),
    ["turn", "model_call", "tool_call"],
  );
});

test("marks a retry: the same target again right after it failed", () => {
  const timeline = buildSessionTimeline(
    input([
      turn("t1", 0, [
        invoke(1, 1, "get_trace", "error"),
        invoke(2, 2, "get_trace"),
        invoke(3, 3, "search_docs"),
      ]),
    ]),
  );
  const tools = timeline.steps.filter((step) => step.kind === "tool_call");
  assert.deepEqual(
    tools.map((step) => step.marks),
    [[], ["retry"], []],
  );
});

test("marks a loop: the same target a third time in a turn, and a search after a tool call", () => {
  const timeline = buildSessionTimeline(
    input([
      turn(
        "t1",
        0,
        [
          invoke(1, 1, "get_trace"),
          invoke(2, 2, "get_trace"),
          search(3, 3),
          invoke(4, 4, "get_trace"),
        ],
        { reSearchCount: 1 },
      ),
    ]),
  );
  const marks = timeline.steps
    .filter((step) => step.kind !== "turn")
    .map((step) => [step.kind, step.marks]);
  assert.deepEqual(marks, [
    ["tool_call", []],
    ["tool_call", []],
    ["search", ["loop"]],
    ["tool_call", ["loop"]],
  ]);
});

test("the same target in two turns is no loop: each turn counts alone", () => {
  const timeline = buildSessionTimeline(
    input([
      turn("t1", 0, [invoke(1, 1, "get_trace"), invoke(2, 2, "get_trace")]),
      turn("t2", 100, [invoke(1, 101, "get_trace")]),
    ]),
  );
  assert.ok(timeline.steps.every((step) => step.marks.length === 0));
});

test("self-corrections the detectors found add their marks to the step they name", () => {
  const timeline = buildSessionTimeline(
    input(
      [turn("t1", 0, [invoke(1, 1, "get_trace", "error"), invoke(2, 2, "search_docs")])],
      [],
      [{ turnId: "t1", kind: "retry_after_error", stepOrdinal: 2 }],
    ),
  );
  assert.deepEqual(
    timeline.steps.find((step) => step.kind === "tool_call" && step.ordinal === 2)?.marks,
    ["retry"],
  );
});

test("marks an abandoned turn on its turn step", () => {
  const timeline = buildSessionTimeline(
    input([turn("t1", 0, [search(1, 1)], { abandoned: true })]),
  );
  assert.deepEqual(timeline.steps[0]?.marks, ["abandoned"]);
});

test("coverage: content when the model call carried text, tokens only when not, expired once the source event is pruned", () => {
  const timeline = buildSessionTimeline(
    input(
      [
        turn("t1", 0, [invoke(1, 2, "get_trace")]),
        turn("t2", 100, [invoke(1, 102, "get_trace")]),
        turn("t3", 200, [search(1, 201, ["a"], false), invoke(2, 202, "get_trace", "ok", false)]),
      ],
      [call("e1", "t1", 1, true), call("e2", "t2", 101, false)],
    ),
  );
  assert.deepEqual(
    timeline.steps.map((step) => [step.kind, step.coverage]),
    [
      ["turn", "content"],
      ["model_call", "content"],
      ["tool_call", "content"],
      ["turn", "tokens_only"],
      ["model_call", "tokens_only"],
      ["tool_call", "tokens_only"],
      ["turn", "expired"],
      ["search", "expired"],
      ["tool_call", "expired"],
    ],
  );
  assert.deepEqual(timeline.coverage, { content: 3, tokens_only: 3, expired: 3 });
});

test("a ledger step with its event but no model call before it has tokens only", () => {
  const timeline = buildSessionTimeline(input([turn("t1", 0, [invoke(1, 1, "get_trace")])]));
  assert.deepEqual(
    timeline.steps.map((step) => step.coverage),
    ["tokens_only", "tokens_only"],
  );
});

test("an empty session has no steps", () => {
  const timeline = buildSessionTimeline(input([]));
  assert.deepEqual(timeline, {
    sessionId: "sess-1",
    turnCount: 0,
    steps: [],
    coverage: { content: 0, tokens_only: 0, expired: 0 },
  });
});
