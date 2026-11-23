import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TurnDetailView } from "@/components/console/traces/TurnDetailView";
import { turnEventAnchor } from "@/lib/readings/trace-signals/view";
import { type TurnHeadRow, type TurnStepRow, toTurnDetail } from "@/lib/views/traces/turn-detail";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const SEARCH_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const START_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const END_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const HEAD: TurnHeadRow = {
  id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  sessionId: "session-7",
  turnSource: "inferred",
  lane: "runtime",
  status: "closed",
  startedAt: new Date("2026-09-25T20:21:07.000Z"),
  endedAt: new Date("2026-09-25T20:21:09.400Z"),
};

const STEP: TurnStepRow = {
  ordinal: 1,
  kind: "search",
  eventType: "search",
  traceEventId: SEARCH_ID,
  endTraceEventId: null,
  occurredAt: new Date("2026-09-25T20:21:07.000Z"),
  gapMs: null,
  hitCount: 12,
  hitIds: Array.from({ length: 12 }, (_, i) => `tool_${i + 1}`),
  hitScores: [0.91, 0.8],
  targetType: null,
  targetId: null,
  outcome: null,
  tookMs: null,
  offeredRank: null,
};

const CALL: TurnStepRow = {
  ...STEP,
  ordinal: 2,
  kind: "invoke",
  eventType: "invoke_start",
  traceEventId: START_ID,
  endTraceEventId: END_ID,
  occurredAt: new Date("2026-09-25T20:21:08.000Z"),
  gapMs: 1_000,
  hitCount: null,
  hitIds: null,
  hitScores: null,
  targetType: "tool",
  targetId: "update_task",
  outcome: "error",
  tookMs: 1_400,
  offeredRank: 7,
};

function detail(traces: readonly string[] = []) {
  return toTurnDetail(
    HEAD,
    [STEP, CALL],
    new Map([
      [
        SEARCH_ID,
        { query: "  move RC-40 to review ", errorMessage: null, traceId: null, spanId: null },
      ],
      [START_ID, { query: null, errorMessage: null, traceId: "t-1", spanId: null }],
      [END_ID, { query: null, errorMessage: "RC-40 is locked", traceId: "t-1", spanId: "s-9" }],
    ]),
    new Set(traces),
    { previousTurnId: null, nextTurnId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" },
  );
}

test("the turn page model keeps the ledger's order, the top ten hits, and the call's end-event error", () => {
  const turn = detail();
  assert.equal(turn.calls.length, 2);
  const [search, call] = turn.calls;
  assert.deepEqual(search?.query, { state: "captured", text: "move RC-40 to review" });
  assert.equal(search?.hitCount, 12);
  assert.equal(search?.hits.length, 10, "the page prints the top ten");
  assert.deepEqual(search?.hits[0], { rank: 1, id: "tool_1", score: 0.91 });
  assert.equal(search?.hits[2]?.score, null);
  assert.equal(call?.errorMessage, "RC-40 is locked");
  assert.equal(call?.offeredRank, 7);
  assert.equal(call?.traceId, null, "the id is not linked until Traces holds it");
  assert.equal(detail(["t-1"]).calls[1]?.traceId, "t-1");
});

test("the turn page rings the focused call, links the trace only when held, and speaks plainly", () => {
  const html = renderToStaticMarkup(
    createElement(TurnDetailView, {
      projectId: PROJECT_ID,
      turn: detail(["t-1"]),
      focusEventId: START_ID,
    }),
  );
  assert.match(html, /A turn on Sep 25, 20:21:07 UTC/);
  assert.match(html, /2 calls over 2\.4 s/);
  assert.match(html, /1 error/);
  assert.match(html, /Turn inferred from timing/);
  assert.match(html, /session-7/);
  assert.match(html, new RegExp(`id="${turnEventAnchor(START_ID)}"[^>]*data-focused="true"`));
  assert.equal((html.match(/data-focused="true"/g) ?? []).length, 1);
  assert.match(html, />The call this example is about</);
  assert.match(html, /“move RC-40 to review”/);
  assert.match(html, />#7 in an earlier search</);
  assert.match(html, />RC-40 is locked</);
  assert.match(html, new RegExp(`href="/project/${PROJECT_ID}/traces/t-1"`));
  assert.match(html, new RegExp(`href="/project/${PROJECT_ID}/health"`), "back to Agent health");
  assert.match(html, /Next turn in this session/);
  assert.doesNotMatch(html, /Previous turn in this session/);
  assert.doesNotMatch(html, /\u2014/, "no em dashes");

  const unheld = renderToStaticMarkup(
    createElement(TurnDetailView, { projectId: PROJECT_ID, turn: detail(), focusEventId: null }),
  );
  assert.doesNotMatch(unheld, /Open trace/);
  assert.doesNotMatch(unheld, /data-focused/);
});
