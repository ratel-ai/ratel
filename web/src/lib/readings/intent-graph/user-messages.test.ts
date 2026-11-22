import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type FoldableEventRow,
  messageWindows,
  withUserMessages,
} from "@/lib/readings/intent-graph/queries";

const T0 = Date.parse("2026-10-20T00:00:00Z");

function row(id: string, partial: Partial<FoldableEventRow> = {}): FoldableEventRow {
  return {
    id,
    type: "search",
    lane: "runtime",
    sessionId: "s1",
    sourceId: null,
    query: null,
    origin: null,
    toolId: null,
    skillId: null,
    topK: null,
    tookMs: null,
    receivedAt: new Date(T0),
    receivedAtRaw: "2026-10-20 00:00:00+00",
    turnId: "t1",
    ...partial,
  };
}

test("a user message lands just before its turn's first row; the page's order is kept", () => {
  const page = [
    row("a", { turnId: "t1" }),
    row("b", { turnId: "t2" }),
    row("c", { turnId: "t1", type: "invoke_start" }),
  ];
  const messages = [
    row("m2", { turnId: "t2", type: "turn_start" as never }),
    row("m1", { turnId: "t1", type: "turn_start" as never }),
  ];
  assert.deepEqual(
    withUserMessages(page, messages).map((r) => r.id),
    ["m1", "a", "m2", "b", "c"],
  );
});

test("a message whose turn is not on the page, or a turn's second message, is dropped", () => {
  const page = [row("a", { turnId: "t1" })];
  const messages = [
    row("m1", { turnId: "t1", type: "turn_start" as never }),
    row("m1b", { turnId: "t1", type: "turn_start" as never }),
    row("m9", { turnId: "t9", type: "turn_start" as never }),
  ];
  assert.deepEqual(
    withUserMessages(page, messages).map((r) => r.id),
    ["m1", "a"],
  );
});

test("an OTLP row never takes a runtime turn's message", () => {
  const page = [
    row("o", { lane: "otlp", sessionId: "s1", turnId: "t1" }),
    row("a", { turnId: "t1" }),
  ];
  const messages = [row("m1", { turnId: "t1", type: "turn_start" as never })];
  assert.deepEqual(
    withUserMessages(page, messages).map((r) => r.id),
    ["o", "m1", "a"],
  );
});

const H = 3_600_000;
const D = 24 * H;

test("message windows: a page's times in one span, a drifted clock in a small window of its own", () => {
  const t = Date.parse("2026-10-20T00:00:00Z");
  assert.deepEqual(messageWindows([t, t + H, t + 3 * H]), [[t - H, t + 4 * H]]);
  const drifted = Date.parse("1990-01-01T00:00:00Z");
  assert.deepEqual(messageWindows([t, drifted, t + H]), [
    [drifted - H, drifted + H],
    [t - H, t + 2 * H],
  ]);
  // A week of replayed history with no day-long gap stays one span.
  const week = Array.from({ length: 7 * 24 }, (_, i) => t + i * H);
  assert.deepEqual(messageWindows(week), [[t - H, t + (7 * 24 - 1) * H + H]]);
});

test("message windows are at most the cap; the closest neighbours merge first", () => {
  const t = Date.parse("2026-10-01T00:00:00Z");
  const sparse = [0, 2, 4, 6, 7.5, 10].map((d) => t + d * D);
  const two = messageWindows(sparse, 2);
  assert.equal(two.length, 2);
  assert.deepEqual(messageWindows(sparse, 5).length, 5);
  assert.deepEqual(messageWindows([], 3), []);
});
