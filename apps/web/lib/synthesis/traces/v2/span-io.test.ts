import assert from "node:assert/strict";
import { test } from "node:test";
import type { TraceContentView } from "@/lib/synthesis/traces/content-view";
import { buildSpanIO } from "./span-io";

const NO_PAYLOAD = null;

test("a tool span with raw content shows its arguments and result", () => {
  const io = buildSpanIO(
    {
      spanId: "t1",
      spanClass: "tool",
      attributes: {
        "gen_ai.tool.call.arguments": '{"q":"weather"}',
        "gen_ai.tool.call.result": '{"temp":21}',
      },
    },
    NO_PAYLOAD,
  );

  assert.deepEqual(io, {
    kind: "tool",
    source: "span",
    arguments: { q: "weather" },
    result: { temp: 21 },
  });
});

test("a model span with raw content splits its messages into input and output", () => {
  const io = buildSpanIO(
    {
      spanId: "m1",
      spanClass: "llm_call",
      attributes: {
        "gen_ai.system_instructions": '[{"type":"text","content":"Be brief."}]',
        "gen_ai.input.messages":
          '[{"role":"user","parts":[{"type":"text","content":"Weather in Rome?"}]}]',
        "gen_ai.output.messages":
          '[{"role":"assistant","parts":[{"type":"text","content":"Let me look."},{"type":"tool_call","id":"c1","name":"search","arguments":{"q":"rome"}}]}]',
      },
    },
    NO_PAYLOAD,
  );

  assert.deepEqual(io, {
    kind: "messages",
    source: "span",
    input: [
      { role: "system", text: "Be brief.", toolCalls: [] },
      { role: "user", text: "Weather in Rome?", toolCalls: [] },
    ],
    output: [
      {
        role: "assistant",
        text: "Let me look.",
        toolCalls: [{ name: "search", arguments: { q: "rome" } }],
      },
    ],
  });
});

test("a model span without content shows its call's payload messages", () => {
  const payload: TraceContentView = {
    contentCaptured: true,
    messages: [
      { id: "m1:system", role: "system", text: "Be brief." },
      { id: "m1:0", role: "user", text: "Weather in Rome?" },
      { id: "m1:1", role: "assistant", text: "Sunny." },
      { id: "m2:2", role: "user", text: "Thanks" },
    ],
    toolCalls: [],
  };

  const io = buildSpanIO({ spanId: "m1", spanClass: "llm_call", attributes: {} }, payload);

  assert.deepEqual(io, {
    kind: "messages",
    source: "payload",
    input: [
      { role: "system", text: "Be brief.", toolCalls: [] },
      { role: "user", text: "Weather in Rome?", toolCalls: [] },
    ],
    output: [{ role: "assistant", text: "Sunny.", toolCalls: [] }],
  });
});

test("a model call's tool calls from the payload are its output", () => {
  const payload: TraceContentView = {
    contentCaptured: true,
    messages: [{ id: "m1:0", role: "user", text: "Weather in Rome?" }],
    toolCalls: [
      {
        id: "c1",
        name: "search",
        arguments: { q: "rome" },
        result: null,
        spanId: "m1",
        durationMs: 0,
        statusCode: 0,
      },
      {
        id: "c2",
        name: "other",
        arguments: {},
        result: null,
        spanId: "m2",
        durationMs: 0,
        statusCode: 0,
      },
    ],
  };

  const io = buildSpanIO({ spanId: "m1", spanClass: "llm_call", attributes: {} }, payload);

  assert.deepEqual(io, {
    kind: "messages",
    source: "payload",
    input: [{ role: "user", text: "Weather in Rome?", toolCalls: [] }],
    output: [
      { role: "assistant", text: "", toolCalls: [{ name: "search", arguments: { q: "rome" } }] },
    ],
  });
});

test("a tool span without content takes its call from the payload by tool call id", () => {
  const payload: TraceContentView = {
    contentCaptured: true,
    messages: [],
    toolCalls: [
      {
        id: "c1",
        name: "search",
        arguments: { q: "rome" },
        result: { temp: 21 },
        spanId: "m1",
        durationMs: 0,
        statusCode: 0,
      },
    ],
  };

  const io = buildSpanIO(
    { spanId: "t1", spanClass: "tool", attributes: { "gen_ai.tool.call.id": "c1" } },
    payload,
  );

  assert.deepEqual(io, {
    kind: "tool",
    source: "payload",
    arguments: { q: "rome" },
    result: { temp: 21 },
  });
});

test("a span with no content anywhere has none", () => {
  assert.deepEqual(
    buildSpanIO({ spanId: "m1", spanClass: "llm_call", attributes: {} }, NO_PAYLOAD),
    { kind: "none" },
  );
  assert.deepEqual(
    buildSpanIO({ spanId: "s1", spanClass: "other", attributes: { foo: "bar" } }, NO_PAYLOAD),
    { kind: "none" },
  );
});

test("a tool result that is not JSON stays text", () => {
  const io = buildSpanIO(
    { spanId: "t1", spanClass: "tool", attributes: { "gen_ai.tool.call.result": "plain text" } },
    NO_PAYLOAD,
  );

  assert.deepEqual(io, { kind: "tool", source: "span", arguments: null, result: "plain text" });
});
