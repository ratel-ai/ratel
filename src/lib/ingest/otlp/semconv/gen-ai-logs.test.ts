import assert from "node:assert/strict";
import { test } from "node:test";
import type { DecodedSpan } from "../types";
import { attachGenAiLogEvents, distinctSpanKeys, type StoredGenAiLog } from "./gen-ai-logs";
import { mapLegacyContent } from "./legacy-content";

const TRACE = "0123456789abcdef0123456789abcdef";
const SPAN = "0123456789abcdef";

function span(overrides: Partial<DecodedSpan> = {}): DecodedSpan {
  return {
    traceId: TRACE,
    spanId: SPAN,
    parentSpanId: null,
    name: "chat gpt-4o",
    kind: 3,
    startUnixMs: 1_750_000_000_000,
    endUnixMs: 1_750_000_001_000,
    attributes: { "gen_ai.operation.name": "chat" },
    events: [],
    statusCode: 1,
    resourceAttributes: {},
    scopeName: null,
    ...overrides,
  };
}

function log(eventName: string, overrides: Partial<StoredGenAiLog> = {}): StoredGenAiLog {
  return {
    traceId: TRACE,
    spanId: SPAN,
    eventName,
    occurredAt: new Date(1_750_000_000_500),
    attributes: {},
    body: null,
    ...overrides,
  };
}

test("a details record becomes the span's details event", () => {
  const spans = [span()];
  attachGenAiLogEvents(spans, [
    log("gen_ai.client.inference.operation.details", {
      attributes: { "gen_ai.input.messages": "[]" },
    }),
  ]);

  assert.deepEqual(spans[0].events, [
    {
      name: "gen_ai.client.inference.operation.details",
      timeUnixMs: 1_750_000_000_500,
      attributes: { "gen_ai.input.messages": "[]" },
    },
  ]);
});

test("per-message records join in time order and map to messages", () => {
  const spans = [span()];
  attachGenAiLogEvents(spans, [
    log("gen_ai.choice", {
      occurredAt: new Date(1_750_000_000_900),
      body: { index: 0, finish_reason: "stop", message: { role: "assistant", content: "hello" } },
    }),
    log("gen_ai.user.message", {
      occurredAt: new Date(1_750_000_000_100),
      body: { content: "hi" },
    }),
    log("gen_ai.system.message", { occurredAt: new Date(1_750_000_000_050), body: "be brief" }),
  ]);
  mapLegacyContent(spans[0]);

  assert.deepEqual(
    spans[0].events.map((event) => event.name),
    ["gen_ai.system.message", "gen_ai.user.message", "gen_ai.choice"],
  );
  assert.equal(
    spans[0].attributes["gen_ai.system_instructions"],
    '[{"type":"text","content":"be brief"}]',
  );
  assert.equal(
    spans[0].attributes["gen_ai.input.messages"],
    '[{"role":"user","parts":[{"type":"text","content":"hi"}]}]',
  );
  assert.equal(
    spans[0].attributes["gen_ai.output.messages"],
    '[{"role":"assistant","parts":[{"type":"text","content":"hello"}],"finish_reason":"stop"}]',
  );
});

test("a span event the span already carries wins over a record of the same name", () => {
  const own = {
    name: "gen_ai.client.inference.operation.details",
    timeUnixMs: 1,
    attributes: { own: true },
  };
  const spans = [span({ events: [own] })];
  attachGenAiLogEvents(spans, [
    log("gen_ai.client.inference.operation.details", { attributes: { own: false } }),
  ]);

  assert.deepEqual(spans[0].events, [own]);
});

test("a record joins only the span with its trace and span id", () => {
  const other = span({ spanId: "fedcba9876543210" });
  const spans = [span(), other];
  attachGenAiLogEvents(spans, [log("gen_ai.user.message", { body: { content: "hi" } })]);

  assert.equal(spans[0].events.length, 1);
  assert.equal(other.events.length, 0);
});

test("distinct span keys skip empty ids and repeats", () => {
  assert.deepEqual(
    distinctSpanKeys([
      { traceId: TRACE, spanId: SPAN },
      { traceId: TRACE, spanId: SPAN },
      { traceId: TRACE, spanId: null },
      { traceId: null, spanId: SPAN },
    ]),
    [{ traceId: TRACE, spanId: SPAN }],
  );
});
