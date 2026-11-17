import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSessionTimeline,
  type TimelineLedgerStep,
  type TimelineModelCall,
  type TimelineTurn,
} from "@/lib/views/session-replay/timeline";
import { buildSessionChat, MIN_SEGMENT_MS, WAIT_TRACK_MS } from "./model";
import {
  adjacentStop,
  axisTicks,
  chatStateAt,
  keyAction,
  nextProblem,
  parsePlayhead,
  parseZoom,
  segmentAt,
  stepAt,
  zoomWindow,
} from "./playback";

/** RC-283: where the playhead is, where ←/→ and "Next problem" take it, and what a zoom shows. */

const T0 = Date.parse("2026-10-20T10:00:00Z");
const at = (ms: number) => new Date(T0 + ms);

function invoke(
  ordinal: number,
  ms: number,
  targetId: string,
  tookMs: number,
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

function call(eventId: string, turnId: string, ms: number, latencyMs: number): TimelineModelCall {
  return {
    eventId,
    turnId,
    occurredAt: at(ms),
    model: "m",
    finishReason: "stop",
    inputTokens: 1,
    outputTokens: 1,
    cachedTokens: 0,
    costUsd: 0,
    latencyMs,
    hasContent: true,
  };
}

function turn(
  id: string,
  startMs: number,
  endMs: number,
  steps: TimelineLedgerStep[],
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
  };
}

/**
 * Track: turn 1 ask 0–300, model 300–1300, tool 1300–1800 (fails), tool 1800–2300 (retry), end 2300;
 * wait 2300–5300; turn 2 ask 5300–5600, model 5600–6600, end 6600.
 */
function session() {
  const turns = [
    turn("t1", 0, 2_000, [invoke(1, 1_000, "quote", 500, "error"), invoke(2, 1_500, "quote", 500)]),
    turn("t2", 120_000, 121_000, []),
  ];
  const calls = [call("c1", "t1", 0, 1_000), call("c2", "t2", 120_000, 1_000)];
  const timeline = buildSessionTimeline({
    sessionId: "s1",
    turns,
    modelCalls: calls,
    selfCorrections: [],
  });
  return buildSessionChat({ timeline, turns, texts: null });
}

test("the layout this file assumes", () => {
  const chat = session();
  assert.deepEqual(
    chat.segments.map((s) => [s.kind, s.stepIndex, s.trackStartMs, s.trackMs]),
    [
      ["ask", 1, 0, MIN_SEGMENT_MS],
      ["model_call", 2, 300, 1_000],
      ["tool_call", 3, 1_300, 500],
      ["tool_call", 4, 1_800, 500],
      ["wait", null, 2_300, WAIT_TRACK_MS],
      ["ask", 5, 5_300, MIN_SEGMENT_MS],
      ["model_call", 6, 5_600, 1_000],
    ],
  );
  assert.equal(chat.trackTotalMs, 6_600);
});

test("position → step: the segment under the playhead, else the last one started", () => {
  const chat = session();
  assert.equal(stepAt(chat, 0), 1);
  assert.equal(stepAt(chat, 299), 1);
  assert.equal(stepAt(chat, 300), 2);
  assert.equal(stepAt(chat, 1_500), 3);
  assert.equal(segmentAt(chat, 3_000)?.kind, "wait");
  assert.equal(stepAt(chat, 3_000), 4);
  assert.equal(stepAt(chat, 6_600), 6);
  assert.equal(stepAt(chat, -5), 1);
});

test("←/→ move to the previous or next step's start, skipping waits", () => {
  const chat = session();
  assert.equal(adjacentStop(chat, 0, 1), 300);
  assert.equal(adjacentStop(chat, 1_500, 1), 1_800);
  assert.equal(adjacentStop(chat, 1_800, 1), 5_300);
  assert.equal(adjacentStop(chat, 5_600, 1), 6_600);
  assert.equal(adjacentStop(chat, 6_600, 1), 6_600);
  assert.equal(adjacentStop(chat, 1_500, -1), 1_300);
  assert.equal(adjacentStop(chat, 1_300, -1), 300);
  assert.equal(adjacentStop(chat, 5_300, -1), 1_800);
  assert.equal(adjacentStop(chat, 0, -1), 0);
});

test("next problem: the first flagged step after the playhead, wrapping to the first", () => {
  const chat = session();
  assert.deepEqual(
    chat.problems.map((p) => [p.stepIndex, p.trackStartMs]),
    [
      [3, 1_300],
      [4, 1_800],
    ],
  );
  assert.equal(nextProblem(chat, 0)?.stepIndex, 3);
  assert.equal(nextProblem(chat, 1_300)?.stepIndex, 4);
  assert.equal(nextProblem(chat, 1_800)?.stepIndex, 3);
  assert.equal(nextProblem({ ...chat, problems: [] }, 0), null);
});

test("zoom window: Fit shows all; 2× and 4× show a half and a quarter around the playhead, inside the track", () => {
  assert.deepEqual(zoomWindow(8_000, 1, 5_000), { startMs: 0, endMs: 8_000 });
  assert.deepEqual(zoomWindow(8_000, 2, 4_000), { startMs: 2_000, endMs: 6_000 });
  assert.deepEqual(zoomWindow(8_000, 4, 4_000), { startMs: 3_000, endMs: 5_000 });
  assert.deepEqual(zoomWindow(8_000, 4, 100), { startMs: 0, endMs: 2_000 });
  assert.deepEqual(zoomWindow(8_000, 4, 7_900), { startMs: 6_000, endMs: 8_000 });
  assert.deepEqual(zoomWindow(0, 4, 0), { startMs: 0, endMs: 0 });
});

test("the chat at the playhead: turns done, the live one with its steps so far, the rest not yet", () => {
  const chat = session();
  const mid = chatStateAt(chat, 1_500);
  assert.deepEqual(
    mid.map((t) => t.phase),
    ["live", "future"],
  );
  const live = mid[0]!;
  assert.ok(live.phase === "live");
  assert.deepEqual(
    live.done.map((s) => s.stepIndex),
    [2],
  );
  assert.equal(live.current?.stepIndex, 3);
  assert.equal(live.currentElapsedMs, 200);
  assert.equal(live.elapsedMs, 1_500);
  assert.deepEqual(
    chatStateAt(chat, 3_000).map((t) => t.phase),
    ["done", "future"],
  );
  assert.deepEqual(
    chatStateAt(chat, 6_600).map((t) => t.phase),
    ["done", "done"],
  );
});

test("the playhead and zoom from the URL", () => {
  assert.equal(parsePlayhead("1500", 6_600), 1_500);
  assert.equal(parsePlayhead(undefined, 6_600), 6_600);
  assert.equal(parsePlayhead("x", 6_600), 6_600);
  assert.equal(parsePlayhead("99999", 6_600), 6_600);
  assert.equal(parsePlayhead("-3", 6_600), 0);
  assert.equal(parseZoom("2"), 2);
  assert.equal(parseZoom("4"), 4);
  assert.equal(parseZoom("fit"), 1);
  assert.equal(parseZoom(null), 1);
  assert.equal(parseZoom("3"), 1);
});

test("axis ticks: a round step, about six labels", () => {
  assert.deepEqual(axisTicks(0, 18_000), [0, 5_000, 10_000, 15_000]);
  assert.deepEqual(axisTicks(0, 6_600), [0, 2_000, 4_000, 6_000]);
  assert.deepEqual(axisTicks(1_200, 2_900), [1_500, 2_000, 2_500]);
  assert.deepEqual(axisTicks(0, 0), [0]);
});

test("keys: Esc closes, ←/→ step, Space plays; nothing while typing or with a modifier", () => {
  const free = { typing: false, modifier: false };
  assert.equal(keyAction("Escape", free), "close");
  assert.equal(keyAction("ArrowLeft", free), "previous");
  assert.equal(keyAction("ArrowRight", free), "next");
  assert.equal(keyAction(" ", free), "toggle_play");
  assert.equal(keyAction("j", free), null);
  for (const key of ["Escape", "ArrowLeft", "ArrowRight", " "]) {
    assert.equal(keyAction(key, { typing: true, modifier: false }), null);
    assert.equal(keyAction(key, { typing: false, modifier: true }), null);
  }
});
