import assert from "node:assert/strict";
import { test } from "node:test";
import { annotateSession } from "./annotations";
import type { Composition } from "./composition";
import { buildSessionTimeline, type TimelineLedgerStep, type TimelineModelCall } from "./timeline";

const T0 = Date.parse("2026-10-20T10:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000);

function search(ordinal: number, s: number, hitIds: string[]): TimelineLedgerStep {
  return {
    ordinal,
    kind: "search",
    traceEventId: `search-${ordinal}`,
    occurredAt: at(s),
    eventPresent: true,
    targetType: null,
    targetId: null,
    outcome: null,
    tookMs: null,
    searchType: "search",
    hitCount: hitIds.length,
    hitIds,
  };
}

function invoke(ordinal: number, s: number, targetId: string, outcome = "ok"): TimelineLedgerStep {
  return {
    ordinal,
    kind: "invoke",
    traceEventId: `invoke-${ordinal}`,
    occurredAt: at(s),
    eventPresent: true,
    targetType: "tool",
    targetId,
    outcome,
    tookMs: 5,
    searchType: null,
    hitCount: null,
    hitIds: null,
  };
}

function call(eventId: string, s: number): TimelineModelCall {
  return {
    eventId,
    turnId: "t1",
    occurredAt: at(s),
    model: "m",
    finishReason: "tool_use",
    inputTokens: 100,
    outputTokens: 1,
    cachedTokens: 0,
    costUsd: 0,
    latencyMs: 1,
    hasContent: false,
  };
}

function loaded(eventId: string, names: string[]): Composition {
  return {
    eventId,
    inputTokens: 100,
    parts: {
      system: 0,
      skills: 0,
      memory: 0,
      tools_used: 0,
      tools_unused: 0,
      history: 0,
      tool_results: 0,
      user_input: 100,
    },
    loadedTools: names.map((name) => ({ name, tokens: 10, calls: 0 })),
    gaps: [],
  };
}

function timelineOf(steps: TimelineLedgerStep[], calls: TimelineModelCall[] = [call("e1", 0.5)]) {
  return buildSessionTimeline({
    sessionId: "s1",
    turns: [
      {
        id: "t1",
        startedAt: at(0),
        endedAt: at(60),
        endedBy: "next_turn",
        abandoned: false,
        detour: false,
        reSearchCount: 0,
        steps,
      },
    ],
    modelCalls: calls,
    selfCorrections: [],
  });
}

test("a pick ranked first by the search is good", () => {
  const timeline = timelineOf([
    search(1, 1, ["get_trace", "search_docs"]),
    invoke(2, 2, "get_trace"),
  ]);
  const { annotations } = annotateSession({
    timeline,
    compositions: new Map([["e1", loaded("e1", ["get_trace", "search_docs"])]]),
    labels: new Map(),
    calibrationMismatches: [],
  });
  assert.deepEqual(annotations, [
    {
      step: 4,
      turnIndex: 1,
      picked: "get_trace",
      better: null,
      reason: "top_ranked",
      verdict: "good",
      rank: 1,
      selectionId: null,
    },
  ]);
});

test("a higher-scored tool the call did not load: scored_higher_not_loaded, and a missing-tool marker on that call", () => {
  const timeline = timelineOf([
    search(1, 1, ["get_trace", "search_docs"]),
    invoke(2, 2, "search_docs"),
  ]);
  const { annotations, missingTools } = annotateSession({
    timeline,
    compositions: new Map([["e1", loaded("e1", ["search_docs"])]]),
    labels: new Map(),
    calibrationMismatches: [],
  });
  assert.deepEqual(annotations, [
    {
      step: 4,
      turnIndex: 1,
      picked: "search_docs",
      better: "get_trace",
      reason: "scored_higher_not_loaded",
      verdict: "bad",
      rank: 2,
      selectionId: null,
    },
  ]);
  assert.deepEqual(missingTools, [{ step: 2, tools: ["get_trace"] }]);
});

test("a higher-scored tool that was loaded: scored_higher, no missing tool", () => {
  const timeline = timelineOf([
    search(1, 1, ["get_trace", "search_docs"]),
    invoke(2, 2, "search_docs"),
  ]);
  const { annotations, missingTools } = annotateSession({
    timeline,
    compositions: new Map([["e1", loaded("e1", ["get_trace", "search_docs"])]]),
    labels: new Map(),
    calibrationMismatches: [],
  });
  assert.equal(annotations[0]?.reason, "scored_higher");
  assert.deepEqual(missingTools, []);
});

test("a pick no search listed is not_offered; a failed call is failed", () => {
  const timeline = timelineOf([search(1, 1, ["get_trace"]), invoke(2, 2, "delete_all", "error")]);
  const { annotations } = annotateSession({
    timeline,
    compositions: new Map(),
    labels: new Map(),
    calibrationMismatches: [],
  });
  assert.deepEqual(
    annotations.map((a) => [a.reason, a.better, a.verdict]),
    [
      ["not_offered", "get_trace", "bad"],
      ["failed", null, "bad"],
    ],
  );
});

test("a label for the search's query agrees or names a better tool", () => {
  const timeline = timelineOf([
    search(1, 1, ["search_docs", "get_trace"]),
    invoke(2, 2, "search_docs"),
  ]);
  const agree = annotateSession({
    timeline,
    compositions: new Map(),
    labels: new Map([[3, "search_docs"]]),
    calibrationMismatches: [],
  });
  assert.deepEqual(
    agree.annotations.map((a) => a.reason),
    ["top_ranked", "label_agrees"],
  );
  const disagree = annotateSession({
    timeline,
    compositions: new Map([["e1", loaded("e1", ["search_docs"])]]),
    labels: new Map([[3, "get_trace"]]),
    calibrationMismatches: [],
  });
  assert.deepEqual(
    disagree.annotations.map((a) => [a.reason, a.better]),
    [
      ["top_ranked", null],
      ["label_disagrees", "get_trace"],
    ],
  );
  assert.deepEqual(disagree.missingTools, [{ step: 2, tools: ["get_trace"] }]);
});

test("calibration mismatches are annotations on their search step, with the selection id", () => {
  const timeline = timelineOf([search(1, 1, ["get_trace"])]);
  const { annotations } = annotateSession({
    timeline,
    compositions: new Map(),
    labels: new Map(),
    calibrationMismatches: [{ step: 3, selectionId: "sel-1" }],
  });
  assert.deepEqual(annotations, [
    {
      step: 3,
      turnIndex: 1,
      picked: null,
      better: null,
      reason: "calibration_mismatch",
      verdict: "bad",
      rank: null,
      selectionId: "sel-1",
    },
  ]);
});

test("annotations hold codes and ids only", () => {
  const timeline = timelineOf([
    search(1, 1, ["get_trace", "search_docs"]),
    invoke(2, 2, "search_docs"),
  ]);
  const { annotations } = annotateSession({
    timeline,
    compositions: new Map(),
    labels: new Map(),
    calibrationMismatches: [],
  });
  for (const annotation of annotations)
    assert.deepEqual(Object.keys(annotation).sort(), [
      "better",
      "picked",
      "rank",
      "reason",
      "selectionId",
      "step",
      "turnIndex",
      "verdict",
    ]);
});
