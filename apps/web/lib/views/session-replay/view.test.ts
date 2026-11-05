import assert from "node:assert/strict";
import { test } from "node:test";
import type { Annotation } from "./annotations";
import type { SessionLens } from "./annotations-load";
import type { Composition } from "./composition";
import { buildSessionTimeline, type TimelineLedgerStep, type TimelineModelCall } from "./timeline";
import { buildSessionView, chipText, coverageText, sessionReplayHref } from "./view";

const T0 = Date.parse("2026-10-20T10:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000);

function annotation(reason: Annotation["reason"], extra: Partial<Annotation> = {}): Annotation {
  return {
    step: 7,
    turnIndex: 1,
    picked: "search_docs",
    better: null,
    reason,
    verdict: "bad",
    rank: null,
    selectionId: null,
    ...extra,
  };
}

test("chips say the annotation in words", () => {
  assert.equal(
    chipText(annotation("scored_higher_not_loaded", { better: "get_trace" })),
    "At step 7 the agent picked search_docs. get_trace scored higher but was not loaded.",
  );
  assert.equal(
    chipText(annotation("scored_higher", { better: "get_trace" })),
    "At step 7 the agent picked search_docs. get_trace scored higher.",
  );
  assert.equal(
    chipText(annotation("top_ranked", { verdict: "good" })),
    "At step 7 the agent picked search_docs, the top search result.",
  );
  assert.equal(
    chipText(annotation("label_agrees", { verdict: "good" })),
    "At step 7 the agent picked search_docs, the tool labelled right for this request.",
  );
  assert.equal(
    chipText(annotation("label_disagrees", { better: "get_trace" })),
    "At step 7 the agent picked search_docs. The label for this request is get_trace.",
  );
  assert.equal(
    chipText(annotation("not_offered", { better: "get_trace" })),
    "At step 7 the agent picked search_docs. No search listed it. The last search ranked get_trace first.",
  );
  assert.equal(
    chipText(annotation("not_offered")),
    "At step 7 the agent picked search_docs. No search listed it.",
  );
  assert.equal(chipText(annotation("failed")), "At step 7 the call to search_docs failed.");
  assert.equal(
    chipText(annotation("calibration_mismatch", { picked: null })),
    "At step 7 the calibration arms ranked the results in a different order.",
  );
});

test("the coverage banner counts steps by coverage", () => {
  assert.equal(
    coverageText({ content: 3, tokens_only: 12, expired: 1 }),
    "Of 16 steps, 3 have content, 12 have token counts only and 1 expired.",
  );
  assert.equal(
    coverageText({ content: 0, tokens_only: 1, expired: 0 }),
    "Of 1 step, 0 have content, 1 has token counts only and 0 expired.",
  );
});

test("the session link encodes the session id", () => {
  assert.equal(sessionReplayHref("p1", "sess/1 a"), "/project/p1/sessions/sess%2F1%20a");
});

function search(ordinal: number, s: number, hitIds: string[]): TimelineLedgerStep {
  return {
    ordinal,
    kind: "search",
    traceEventId: `s${ordinal}`,
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
    traceEventId: `i${ordinal}`,
    occurredAt: at(s),
    eventPresent: true,
    targetType: "tool",
    targetId,
    outcome,
    tookMs: 12,
    searchType: null,
    hitCount: null,
    hitIds: null,
  };
}
function call(eventId: string, s: number, inputTokens: number): TimelineModelCall {
  return {
    eventId,
    turnId: "t1",
    occurredAt: at(s),
    model: "claude-sonnet-5-5",
    finishReason: "tool_use",
    inputTokens,
    outputTokens: 20,
    cachedTokens: 0,
    costUsd: 0.002,
    latencyMs: 640,
    hasContent: false,
  };
}
function comp(eventId: string, inputTokens: number): Composition {
  return {
    eventId,
    inputTokens,
    parts: {
      system: 100,
      skills: 0,
      memory: 0,
      tools_used: 50,
      tools_unused: 150,
      history: inputTokens - 400,
      tool_results: 0,
      user_input: 100,
    },
    loadedTools: [],
    gaps: ["tool_results_in_history"],
  };
}

test("the view: a row per step, a context bar at each model call, markers and chips on their steps", () => {
  const timeline = buildSessionTimeline({
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
        steps: [
          search(1, 2, ["get_trace", "search_docs"]),
          invoke(2, 4, "search_docs", "error"),
          invoke(3, 5, "search_docs"),
        ],
      },
    ],
    modelCalls: [call("e1", 1, 1000), call("e2", 3, 2400)],
    selfCorrections: [],
  });
  const lens: SessionLens = {
    calls: [
      { step: 2, composition: comp("e1", 1000) },
      { step: 4, composition: comp("e2", 2400) },
    ],
    bloatStartStep: 4,
    unusedTools: [{ step: 2, tools: ["a", "b", "c", "d", "e", "f", "g"] }],
    missingTools: [{ step: 4, tools: ["get_trace"] }],
    annotations: [
      {
        step: 5,
        turnIndex: 1,
        picked: "search_docs",
        better: "get_trace",
        reason: "scored_higher_not_loaded",
        verdict: "bad",
        rank: 2,
        selectionId: null,
      },
    ],
    gaps: ["no_window_size"],
  };
  const view = buildSessionView(timeline, lens);
  assert.deepEqual(
    view.rows.map((row) => [row.index, row.kind, row.title]),
    [
      [1, "turn", "Turn 1"],
      [2, "model_call", "Model call · claude-sonnet-5-5"],
      [3, "search", "Search · 2 hits"],
      [4, "model_call", "Model call · claude-sonnet-5-5"],
      [5, "tool_call", "search_docs · failed"],
      [6, "tool_call", "search_docs · ok"],
    ],
  );
  const bar = view.rows[1]!.bar!;
  assert.equal(bar.total, 1000);
  assert.deepEqual(
    bar.segments.map((segment) => [segment.part, segment.tokens]),
    [
      ["system", 100],
      ["tools_used", 50],
      ["tools_unused", 150],
      ["history", 600],
      ["user_input", 100],
    ],
  );
  assert.equal(view.rows[2]!.bar, null);
  assert.deepEqual(
    view.rows[1]!.markers.map((marker) => [marker.kind, marker.text]),
    [["unused_tool", "Loaded and never used: a, b, c, d, e and 2 more."]],
  );
  assert.deepEqual(
    view.rows[3]!.markers.map((marker) => marker.kind),
    ["missing_tool", "bloat_start"],
  );
  assert.equal(view.rows[3]!.markers[0]!.text, "Needed and not loaded: get_trace.");
  assert.deepEqual(view.rows[4]!.chips, [
    {
      tone: "bad",
      text: "At step 5 the agent picked search_docs. get_trace scored higher but was not loaded.",
    },
  ]);
  assert.deepEqual(view.rows[5]!.marks, [{ code: "retry", label: "Retry" }]);
  assert.equal(view.rows[1]!.lensStep, 2);
  assert.equal(view.rows[2]!.lensStep, 2, "a search shows the context of the call before it");
  assert.equal(view.rows[0]!.lensStep, null);
  assert.deepEqual(view.totals, {
    turns: 1,
    modelCalls: 2,
    toolCalls: 2,
    inputTokens: 3400,
    costUsd: 0.004,
  });
  assert.equal(view.coverage.tone, "info");
  assert.deepEqual(view.gaps, [
    "Tool results are counted in history where the call kept no text.",
    "The context window size is not known.",
  ]);
});
