import assert from "node:assert/strict";
import { test } from "node:test";
import { toChatExample } from "../domain/jsonl";
import type { RowContent } from "../domain/rows";

/** RC-1131: a stored row as an OpenAI chat fine-tuning example. */

test("a call with system text, a tool call and a tool result maps to the hand-written JSONL line", () => {
  const content: RowContent = {
    system: "You route refunds.",
    tools: [
      {
        name: "lookup_order",
        description: "Find an order.",
        parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      },
    ],
    messages: [
      { role: "user", content: "Where is order 1?" },
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "call_1", name: "lookup_order", arguments: { id: "1" } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: '{"status":"shipped"}' },
    ],
    output: [
      {
        role: "assistant",
        content: [
          { type: "text", text: "It shipped. " },
          { type: "text", text: "Track it here." },
        ],
      },
    ],
  };
  const expected =
    '{"messages":[' +
    '{"role":"system","content":"You route refunds."},' +
    '{"role":"user","content":"Where is order 1?"},' +
    '{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"lookup_order","arguments":"{\\"id\\":\\"1\\"}"}}]},' +
    '{"role":"tool","tool_call_id":"call_1","content":"{\\"status\\":\\"shipped\\"}"},' +
    '{"role":"assistant","content":"It shipped. Track it here."}' +
    '],"tools":[{"type":"function","function":{"name":"lookup_order","description":"Find an order.","parameters":{"type":"object","properties":{"id":{"type":"string"}},"required":["id"]}}}]}';
  const example = toChatExample(content);
  assert.ok(example.ok);
  assert.equal(example.line, expected);
});

test("the recorded reply keeps its tool calls as the last assistant message; no tools and no system leave those out", () => {
  const example = toChatExample({
    messages: [{ role: "user", content: "refund 2" }],
    output: [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Checking." },
          { type: "tool_call", id: "c2", name: "refund", arguments: { order: 2 } },
        ],
      },
    ],
  });
  assert.ok(example.ok);
  assert.deepEqual(JSON.parse(example.line), {
    messages: [
      { role: "user", content: "refund 2" },
      {
        role: "assistant",
        content: "Checking.",
        tool_calls: [
          { id: "c2", type: "function", function: { name: "refund", arguments: '{"order":2}' } },
        ],
      },
    ],
  });
});

test("rows the format cannot express are skipped with a reason", () => {
  const user = { role: "user" as const, content: "hi" };
  assert.deepEqual(toChatExample({ messages: [user], output: [] }), {
    ok: false,
    reason: "no_reply",
  });
  assert.deepEqual(
    toChatExample({
      messages: [user],
      output: [{ role: "tool", tool_call_id: "x", content: "r" }],
    }),
    { ok: false, reason: "no_reply" },
  );
  assert.deepEqual(
    toChatExample({ messages: [user], output: [{ role: "assistant", content: "  " }] }),
    { ok: false, reason: "empty_reply" },
  );
  assert.deepEqual(
    toChatExample({ messages: [], output: [{ role: "assistant", content: "ok" }] }),
    { ok: false, reason: "no_input" },
  );
  assert.deepEqual(
    toChatExample({
      messages: [
        {
          role: "user",
          content: [{ type: "image", url: "https://x/y.png", media_type: "image/png" }],
        },
      ],
      output: [{ role: "assistant", content: "ok" }],
    }),
    { ok: false, reason: "unsupported_content" },
  );
});

test("a reply followed by trailing tool results ends at its last assistant message", () => {
  const example = toChatExample({
    messages: [{ role: "user", content: "go" }],
    output: [
      { role: "assistant", content: [{ type: "tool_call", id: "c3", name: "run", arguments: {} }] },
      { role: "tool", tool_call_id: "c3", content: "done" },
    ],
  });
  assert.ok(example.ok);
  const messages = (JSON.parse(example.line) as { messages: { role: string }[] }).messages;
  assert.deepEqual(
    messages.map((m) => m.role),
    ["user", "assistant"],
  );
});
