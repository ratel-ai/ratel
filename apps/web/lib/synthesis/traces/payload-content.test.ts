import assert from "node:assert/strict";
import { test } from "node:test";
import type { CloudEvent } from "@/lib/ingest/cloud-schema";
import { preferSpanContent, type TraceContentView } from "./content-view";
import { buildPayloadContent, type PayloadCall } from "./payload-content";
import { conversationMessages } from "./v2/conversation";

const AT = Date.parse("2026-11-09T10:00:00.000Z");

test("a trace's payload messages read as its conversation, each once, and content is captured", () => {
  const content = buildPayloadContent([
    call(1, {
      system: "You are the Site Copilot.",
      messages: [{ role: "user", content: "Where is order 1234?" }],
      input_message_count: 1,
    }),
    call(2, {
      system: "You are the Site Copilot.",
      messages: [
        { role: "user", content: "Where is order 1234?" },
        {
          role: "assistant",
          content: [
            { type: "tool_call", id: "call_1", name: "lookup_order", arguments: { id: "1234" } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: '{"status":"shipped"}' },
        { role: "assistant", content: [{ type: "text", text: "It shipped yesterday." }] },
      ],
      input_message_count: 3,
    }),
  ]);

  assert.equal(content.view.contentCaptured, true);
  assert.deepEqual(
    conversationMessages(content.view.messages).map(({ role, text }) => [role, text]),
    [
      ["system", "You are the Site Copilot."],
      ["user", "Where is order 1234?"],
      ["tool", '{"status":"shipped"}'],
      ["assistant", "It shipped yesterday."],
    ],
  );
  assert.equal(content.ask, "Where is order 1234?");
});

test("tool calls carry their arguments and results from the payload messages, each call once", () => {
  const history = [
    { role: "user", content: "Refund order 9" },
    {
      role: "assistant",
      content: [{ type: "tool_call", id: "call_9", name: "refund", arguments: { order: 9 } }],
    },
    { role: "tool", tool_call_id: "call_9", content: '{"ok":true}' },
  ] satisfies CloudEvent["messages"];
  const content = buildPayloadContent([
    call(1, { messages: history.slice(0, 2), input_message_count: 1 }),
    call(2, {
      messages: [...history, { role: "assistant", content: "Done." }],
      input_message_count: 3,
    }),
  ]);

  assert.deepEqual(content.view.toolCalls, [
    {
      id: "call_9",
      name: "refund",
      arguments: { order: 9 },
      result: { ok: true },
      spanId: "span-1",
      durationMs: 1200,
      statusCode: 0,
    },
  ]);
});

test("the ask is the last user message going into the first call that has one", () => {
  const content = buildPayloadContent([
    call(2, {
      messages: [
        { role: "user", content: "an older question" },
        { role: "assistant", content: "an older answer" },
        { role: "user", content: [{ type: "text", text: "  What changed today?  " }] },
        { role: "assistant", content: "Nothing." },
      ],
      input_message_count: 3,
    }),
    // Stored out of order: the earliest call wins, not the first row.
    call(1, { messages: [], input_message_count: 0 }),
  ]);
  assert.equal(content.ask, "What changed today?");
});

test("a call stored before input_message_count existed shows its separate output once", () => {
  const content = buildPayloadContent([
    call(1, {
      messages: [{ role: "user", content: "Hi" }],
      output: [{ role: "assistant", content: "Hello!" }],
    }),
  ]);
  assert.deepEqual(
    content.view.messages.map(({ role, text }) => [role, text]),
    [
      ["user", "Hi"],
      ["assistant", "Hello!"],
    ],
  );
});

test("payloads without message text capture nothing", () => {
  const content = buildPayloadContent([call(1, { messages: [{ role: "user", content: "" }] })]);
  assert.deepEqual(content, {
    view: { messages: [], toolCalls: [], contentCaptured: false },
    ask: null,
  });
  assert.deepEqual(buildPayloadContent([]).view.contentCaptured, false);
});

test("span content wins when the spans carry it; the payload fills in when they carry none", () => {
  const empty: TraceContentView = { messages: [], toolCalls: [], contentCaptured: false };
  const fromSpans: TraceContentView = {
    messages: [{ id: "s", role: "user", text: "from spans" }],
    toolCalls: [],
    contentCaptured: true,
  };
  const fromPayload: TraceContentView = {
    messages: [{ id: "p", role: "user", text: "from payload" }],
    toolCalls: [],
    contentCaptured: true,
  };
  assert.equal(preferSpanContent(fromSpans, fromPayload), fromSpans);
  assert.equal(preferSpanContent(empty, fromPayload), fromPayload);
  assert.equal(preferSpanContent(empty, null), empty);
  assert.equal(preferSpanContent(empty, empty), empty);
});

function call(
  index: number,
  payload: Partial<CloudEvent> & Pick<CloudEvent, "messages">,
): PayloadCall {
  return {
    eventId: `event-${index}`,
    spanId: `span-${index}`,
    occurredAt: new Date(AT + index * 1000),
    latencyMs: 1200,
    payload: {
      provider: "openai",
      model: "gpt-5",
      ts: new Date(AT + index * 1000).toISOString(),
      ...payload,
    },
  };
}

test("each message is kept once on the server, however many calls repeat the history", () => {
  const history = [
    { role: "user", content: "Where is order 1234?" },
    { role: "assistant", content: "Checking." },
    { role: "user", content: "Thanks" },
  ] satisfies CloudEvent["messages"];
  const content = buildPayloadContent([
    call(1, { system: "Be brief.", messages: history.slice(0, 1), input_message_count: 1 }),
    call(2, { system: "Be brief.", messages: history.slice(0, 2), input_message_count: 1 }),
    call(3, { system: "Be brief.", messages: history, input_message_count: 3 }),
  ]);
  assert.deepEqual(
    content.view.messages.map(({ role, text }) => [role, text]),
    [
      ["system", "Be brief."],
      ["user", "Where is order 1234?"],
      ["assistant", "Checking."],
      ["user", "Thanks"],
    ],
  );
});
