import assert from "node:assert/strict";
import { test } from "node:test";
import { chatTextOf } from "./text";

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const toolCall = {
  role: "assistant",
  content: [{ type: "tool_call", id: "c1", name: "quote", arguments: {} }],
};
const toolResult = { role: "tool", tool_call_id: "c1", content: "42" };

test("the ask is the last person message of the input; the reply is the stored output", () => {
  const payload = {
    messages: [user("Hi"), assistant("Hello"), user("Book Lisbon"), assistant("Done.")],
    input_message_count: 3,
    output: [assistant("Done.")],
  };
  assert.deepEqual(chatTextOf(payload), { ask: "Book Lisbon", reply: "Done." });
});

test("without a stored output, the reply is the trailing assistant text after the input", () => {
  const payload = {
    messages: [user("Book Lisbon"), toolCall, toolResult, assistant("Booked.")],
    input_message_count: 3,
  };
  assert.deepEqual(chatTextOf(payload), { ask: "Book Lisbon", reply: "Booked." });
});

test("an older row with no input count reads its trailing assistant messages as the reply", () => {
  const payload = { messages: [user("Book Lisbon"), assistant("Booked.")] };
  assert.deepEqual(chatTextOf(payload), { ask: "Book Lisbon", reply: "Booked." });
});

test("a reply of tool calls only has no text; string content counts", () => {
  const payload = {
    messages: [{ role: "user", content: "Book Lisbon" }, toolCall],
    input_message_count: 1,
  };
  assert.deepEqual(chatTextOf(payload), { ask: "Book Lisbon", reply: null });
});

test("full text, not cut short", () => {
  const long = "x".repeat(5_000);
  assert.equal(chatTextOf({ messages: [user(long)], input_message_count: 1 }).ask, long);
});

test("a payload with no text has neither", () => {
  assert.deepEqual(chatTextOf({ messages: [{ role: "user", content: "" }] }), {
    ask: null,
    reply: null,
  });
  assert.deepEqual(chatTextOf(null), { ask: null, reply: null });
});
