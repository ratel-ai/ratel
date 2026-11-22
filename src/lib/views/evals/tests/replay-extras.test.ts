import assert from "node:assert/strict";
import { test } from "node:test";
import { earlierHistory, evalReplayExtras, toMock } from "../replay-extras";

test("RC-295: earlier messages become history; a tool message is the agent's call and its answer", () => {
  assert.deepEqual(
    earlierHistory([
      { role: "user", text: "Hi, I'm Ana" },
      { role: "tool", text: '{"booking":"R1"}', tool: "find_booking", args: { ref: "R1" } },
      { role: "tool", text: '{"error":"down"}', tool: "get_fare" },
      { role: "assistant", text: "Found it." },
      { role: "tool", text: "orphan" },
    ]),
    [
      { role: "user", text: "Hi, I'm Ana" },
      {
        role: "assistant",
        text: "",
        calls: [{ id: "earlier_1", name: "find_booking", args: { ref: "R1" } }],
      },
      { role: "tool", callId: "earlier_1", content: '{"booking":"R1"}', isError: false },
      { role: "assistant", text: "", calls: [{ id: "earlier_2", name: "get_fare", args: {} }] },
      { role: "tool", callId: "earlier_2", content: '{"error":"down"}', isError: true },
      { role: "assistant", text: "Found it.", calls: [] },
    ],
  );
});

test("RC-295: a fixed answer becomes a mock: JSON or text, failing on an error field, with its condition and reason", () => {
  assert.deepEqual(
    toMock({
      tool: "get_seat_map",
      result: { free: [] },
      when: { flight: "F1" },
      why: " Full plane ",
    }),
    {
      tool: "get_seat_map",
      content: '{"free":[]}',
      isError: false,
      when: { flight: "F1" },
      why: "Full plane",
    },
  );
  assert.deepEqual(toMock({ tool: "pay", result: { error: "card declined" }, when: {}, why: "" }), {
    tool: "pay",
    content: '{"error":"card declined"}',
    isError: true,
  });
  assert.deepEqual(toMock({ tool: "note", result: "plain words" }), {
    tool: "note",
    content: "plain words",
    isError: false,
  });
});

test("RC-295: an eval with neither gives empty extras", () => {
  assert.deepEqual(evalReplayExtras({ earlierMessages: [], fixedAnswers: [] }), {
    history: [],
    mocks: [],
  });
});
