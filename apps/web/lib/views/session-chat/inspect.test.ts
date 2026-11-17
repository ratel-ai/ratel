import assert from "node:assert/strict";
import { test } from "node:test";
import { callDiff, parseCallPayload, toolStepContent } from "./inspect";

/** RC-284: one model call's sections, and what changed since the call before it. */

const tool = (name: string) => ({
  name,
  description: `${name} does it`,
  parameters: { type: "object" },
});
const user = (text: string) => ({ role: "user", content: text });
const call = (id: string, name: string, args: Record<string, unknown>) => ({
  role: "assistant",
  content: [{ type: "tool_call", id, name, arguments: args }],
});
const result = (id: string, text: string) => ({ role: "tool", tool_call_id: id, content: text });

const FIRST = {
  system:
    'You are Meridian\'s assistant.\n<skills><skill name="seat-change">Seats.</skill></skills>',
  tools: [tool("find_booking"), tool("search_hotels")],
  messages: [
    user("Move me to an aisle seat. Booking MRD4X7."),
    call("c1", "find_booking", { booking_ref: "MRD4X7" }),
  ],
  input_message_count: 1,
  settings: { temperature: 0.2, max_tokens: 1024 },
};
const SECOND = {
  system: FIRST.system,
  tools: [tool("find_booking"), tool("get_seat_map"), tool("hold_seat")],
  messages: [
    user("Move me to an aisle seat. Booking MRD4X7."),
    call("c1", "find_booking", { booking_ref: "MRD4X7" }),
    result("c1", '{"flight":"MR214"}'),
    call("c2", "get_seat_map", { flight_id: "MR214" }),
  ],
  input_message_count: 3,
  output: [call("c2", "get_seat_map", { flight_id: "MR214" })],
  params: { temperature: 0.2 },
};

test("sections: system prompt, skills, tools, messages, output and settings", () => {
  const view = parseCallPayload(SECOND);
  assert.equal(view.system, SECOND.system);
  assert.deepEqual(view.skills, ["seat-change"]);
  assert.deepEqual(
    view.tools.map((t) => t.name),
    ["find_booking", "get_seat_map", "hold_seat"],
  );
  assert.equal(view.messages.length, 3);
  assert.deepEqual(
    view.messages.map((m) => m.role),
    ["user", "assistant", "tool"],
  );
  assert.deepEqual(view.messages[1]!.toolCalls, [
    { id: "c1", name: "find_booking", arguments: { booking_ref: "MRD4X7" } },
  ]);
  assert.equal(view.messages[2]!.text, '{"flight":"MR214"}');
  assert.deepEqual(
    view.output.map((m) => m.toolCalls[0]?.name),
    ["get_seat_map"],
  );
  assert.deepEqual(view.settings, { temperature: 0.2 });
  assert.deepEqual(parseCallPayload(FIRST).settings, { temperature: 0.2, max_tokens: 1024 });
});

test("an older row without input count or output: all messages are input, the trailing assistant ones are output", () => {
  const view = parseCallPayload({
    messages: [user("hi"), { role: "assistant", content: [{ type: "text", text: "hello" }] }],
  });
  assert.equal(view.messages.length, 1);
  assert.equal(view.output[0]!.text, "hello");
});

test("first call of a session: every message is new, every tool is new", () => {
  const diff = callDiff(null, parseCallPayload(FIRST), new Set(["find_booking"]));
  assert.equal(diff.firstCall, true);
  assert.deepEqual(diff.newMessages, [0]);
  assert.deepEqual(diff.toolsAdded, ["find_booking", "search_hotels"]);
  assert.deepEqual(diff.toolsRemoved, []);
  assert.deepEqual(diff.tools, [
    { name: "find_booking", tags: ["called_here", "new"] },
    { name: "search_hotels", tags: ["never_called", "new"] },
  ]);
});

test("a later call: new messages, a new tool, a never-called tool, a dropped tool", () => {
  const diff = callDiff(
    parseCallPayload(FIRST),
    parseCallPayload(SECOND),
    new Set(["find_booking", "get_seat_map"]),
  );
  assert.equal(diff.firstCall, false);
  assert.deepEqual(diff.newMessages, [2]);
  assert.deepEqual(diff.toolsAdded, ["get_seat_map", "hold_seat"]);
  assert.deepEqual(diff.toolsRemoved, ["search_hotels"]);
  assert.deepEqual(diff.tools, [
    { name: "find_booking", tags: [] },
    { name: "get_seat_map", tags: ["called_here", "new"] },
    { name: "hold_seat", tags: ["never_called", "new"] },
  ]);
  assert.equal(
    diff.summary,
    "+1 message · tools in: get_seat_map, hold_seat · tools out: search_hotels",
  );
});

test("a call that changed nothing says so", () => {
  const view = parseCallPayload(FIRST);
  assert.equal(
    callDiff(view, view, new Set(["find_booking", "search_hotels"])).summary,
    "No change since the last call",
  );
});

test("a tool step's arguments from the call that chose it and its result from the call after", () => {
  const content = toolStepContent(
    "get_seat_map",
    parseCallPayload(SECOND),
    parseCallPayload({
      messages: [...SECOND.messages, result("c2", '{"seats":["14C"]}')],
      input_message_count: 5,
    }),
  );
  assert.deepEqual(content, { arguments: { flight_id: "MR214" }, result: '{"seats":["14C"]}' });
  assert.deepEqual(toolStepContent("get_seat_map", null, null), { arguments: null, result: null });
});
