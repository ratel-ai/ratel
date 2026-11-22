import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReplayTranscriptStep } from "@/lib/views/eval-gate/types";
import { toolStepContent } from "@/lib/views/session-chat/inspect";
import { type EvalChatItem, type EvalChatResult, evalChat, evalStepSource } from "../domain/chat";
import type { EvalToolAnswer } from "../domain/types";
import { LEAD_FRAMES, replayModel } from "../replay-view";

const STEPS: ReplayTranscriptStep[] = [
  {
    role: "assistant",
    text: "Let me look.",
    calls: [
      { name: "get_seat_map", args: { ref: "R1" } },
      { name: "find_booking", args: { ref: "R1" } },
    ],
  },
  { role: "tool", tool: "get_seat_map", content: '{"free":["23A"]}', isError: false },
  { role: "tool", tool: "find_booking", content: '{"booking":"R1"}', isError: false },
  {
    role: "assistant",
    text: "",
    calls: [{ name: "select_seat", args: { ref: "R1", seat: "23A" } }],
  },
  { role: "tool", tool: "select_seat", content: '{"seat":"23A"}', isError: false },
  { role: "assistant", text: "Seat 23A is yours.", calls: [] },
];

const ANSWERS: EvalToolAnswer[] = [
  { tool: "get_seat_map", source: "recorded", reason: "matched_recording", ms: 700 },
  {
    tool: "find_booking",
    source: "mock",
    reason: "fixed_answer",
    ms: 1_300,
    why: "The booking is R1",
  },
  { tool: "select_seat", source: "stand-in", reason: "stand_in_model", ms: 300 },
];

const ITEM: EvalChatItem = {
  systemPrompt: "You book seats.",
  message: "Get me a seat on R1.",
  earlierMessages: [],
  tools: [{ name: "get_seat_map", description: "Seats", parameters: { type: "object" } }],
  generated: ["systemPrompt"],
};

const CREATED = new Date("2026-11-13T10:00:05Z");

function result(over: Partial<EvalChatResult> = {}): EvalChatResult {
  return {
    id: "r1",
    transcript: { toolsOffered: ["get_seat_map", "find_booking", "select_seat"], steps: STEPS },
    toolAnswers: ANSWERS,
    turns: null,
    durationMs: 5_000,
    costUsd: 0.03,
    generated: ["systemPrompt"],
    createdAt: CREATED,
    ...over,
  };
}

test("RC-647: a single-turn run is one turn: the message, each model step and tool call in order, and the reply", () => {
  const out = evalChat(ITEM, result())!;
  const { chat } = out;
  assert.equal(chat.textOff, false);
  assert.equal(chat.turns.length, 1);
  assert.equal(chat.turns[0]!.ask, "Get me a seat on R1.");
  assert.equal(chat.turns[0]!.reply, "Seat 23A is yours.");
  assert.equal(chat.turns[0]!.work.actions, 3);
  assert.deepEqual(
    chat.segments.map((s) => [s.kind, s.label]),
    [
      ["ask", "Ask"],
      ["model_call", "Model call"],
      ["tool_call", "get_seat_map"],
      ["tool_call", "find_booking"],
      ["model_call", "Model call"],
      ["tool_call", "select_seat"],
      ["model_call", "Model call"],
    ],
  );
  assert.equal(chat.calls.length, 3);
  assert.equal(
    chat.turns[0]!.startedAt,
    "2026-11-13T10:00:00.000Z",
    "The run starts its duration before the result was stored.",
  );
});

test("RC-647: times come from the step ms; the model steps share the rest of the run's duration", () => {
  const { chat } = evalChat(ITEM, result())!;
  const tools = chat.segments.filter((s) => s.kind === "tool_call").map((s) => s.realMs);
  assert.deepEqual(tools, [700, 1_300, 300]);
  assert.deepEqual(
    chat.calls.map((c) => c.latencyMs),
    [900, 900, 900],
  );
  assert.deepEqual(
    chat.calls.map((c) => c.costUsd),
    [0.01, 0.01, 0.01],
  );
  const unmeasured = evalChat(
    ITEM,
    result({
      durationMs: null,
      costUsd: null,
      toolAnswers: ANSWERS.map((a) => ({ ...a, ms: null })),
    }),
  )!.chat;
  assert.deepEqual(
    unmeasured.calls.map((c) => c.latencyMs),
    [null, null, null],
  );
  assert.ok(
    unmeasured.segments.every((s, i, all) => i === 0 || s.trackStartMs >= all[i - 1]!.trackStartMs),
    "Unmeasured steps keep their order.",
  );
});

test("RC-647: a multi-turn run (simulated person) is one turn per message, each with its own reply", () => {
  const steps: ReplayTranscriptStep[] = [
    { role: "assistant", text: "", calls: [{ name: "get_seat_map", args: { ref: "R1" } }] },
    { role: "tool", tool: "get_seat_map", content: '{"free":["23A","1F"]}', isError: false },
    { role: "assistant", text: "23A or 1F?", calls: [] },
    { role: "assistant", text: "", calls: [{ name: "select_seat", args: { seat: "1F" } }] },
    { role: "tool", tool: "select_seat", content: '{"seat":"1F"}', isError: false },
    { role: "assistant", text: "1F is yours.", calls: [] },
  ];
  const turns = [
    { simulated: false, message: "Get me a seat on R1.", passed: true, verdicts: [], answers: 1 },
    { simulated: true, message: "The window one, please.", passed: true, verdicts: [], answers: 1 },
  ];
  const toolAnswers: EvalToolAnswer[] = [
    { tool: "get_seat_map", source: "recorded", reason: "matched_recording", ms: 200 },
    { tool: "select_seat", source: "stand-in", reason: "stand_in_model", ms: 100 },
  ];
  const { chat } = evalChat(
    ITEM,
    result({ transcript: { toolsOffered: [], steps }, toolAnswers, turns }),
  )!;
  assert.deepEqual(
    chat.turns.map((t) => [t.ask, t.reply, t.work.actions]),
    [
      ["Get me a seat on R1.", "23A or 1F?", 1],
      ["The window one, please.", "1F is yours.", 1],
    ],
  );
  assert.deepEqual(
    chat.calls.map((c) => c.turnIndex),
    [1, 1, 2, 2],
  );
});

test("RC-647: stand-in answers carry their source and reason; a failed call is a problem to check", () => {
  const failed = STEPS.map((s, i) => (i === 4 && s.role === "tool" ? { ...s, isError: true } : s));
  const out = evalChat(ITEM, result({ transcript: { toolsOffered: [], steps: failed } }))!;
  const tools = out.chat.segments.filter((s) => s.kind === "tool_call");
  assert.deepEqual(
    tools.map((s) => out.steps[s.stepIndex!]!.answer?.source),
    ["recorded", "mock", "stand-in"],
  );
  assert.equal(out.steps[tools[1]!.stepIndex!]!.answer?.why, "The booking is R1");
  assert.equal(out.steps[tools[2]!.stepIndex!]!.answer?.reason, "stand_in_model");
  assert.deepEqual(out.steps[tools[2]!.stepIndex!]!.transcriptIndex, 4);
  assert.deepEqual(
    out.chat.problems.map((p) => [p.stepIndex, p.kinds]),
    [[tools[2]!.stepIndex, ["failed"]]],
  );
});

test("RC-647: the inspector source gives the system prompt, each call's input, and each tool call's arguments and result", async () => {
  const out = evalChat(ITEM, result())!;
  const source = evalStepSource(out);
  const [first, second] = out.chat.calls;
  const answer = await source({ eventIds: [first!.eventId, second!.eventId] });
  assert.ok(answer.ok && answer.content);
  const firstView = answer.content.calls[first!.eventId]!.view;
  assert.equal(firstView.system, "You book seats.");
  assert.deepEqual(
    firstView.tools.map((t) => t.name),
    ["get_seat_map"],
  );
  assert.deepEqual(
    firstView.messages.map((m) => [m.role, m.text]),
    [["user", "Get me a seat on R1."]],
  );
  assert.deepEqual(
    firstView.output[0]!.toolCalls.map((c) => c.name),
    ["get_seat_map", "find_booking"],
  );
  const secondView = answer.content.calls[second!.eventId]!.view;
  assert.deepEqual(
    secondView.messages.map((m) => m.role),
    ["user", "assistant", "tool", "tool"],
  );
  assert.deepEqual(toolStepContent("find_booking", firstView, secondView), {
    arguments: { ref: "R1" },
    result: '{"booking":"R1"}',
  });
  assert.deepEqual(
    out.generated,
    ["systemPrompt"],
    "The Generated mark: the spec fields a model wrote that this run used.",
  );
  const missing = await source({ eventIds: ["nope"] });
  assert.deepEqual(missing, { ok: true, content: { calls: {}, query: null } });
});

test("RC-647: earlier messages come before the message in every call's input", async () => {
  const item: EvalChatItem = {
    ...ITEM,
    earlierMessages: [
      { role: "user", text: "Hi" },
      { role: "tool", tool: "find_booking", args: { ref: "R1" }, text: "{}" },
    ],
  };
  const out = evalChat(item, result())!;
  const answer = await evalStepSource(out)({ eventIds: [out.chat.calls[0]!.eventId] });
  assert.ok(answer.ok && answer.content);
  assert.deepEqual(
    answer.content.calls[out.chat.calls[0]!.eventId]!.view.messages.map((m) => m.role),
    ["user", "assistant", "tool", "user"],
  );
});

test("RC-647: the differs marker is the chat step of the compare view's first differing step", () => {
  const changed = STEPS.map((s, i) =>
    i === 4 && s.role === "tool" ? { ...s, content: '{"error":"taken"}' } : s,
  );
  const previous = result();
  const current = result({ transcript: { toolsOffered: [], steps: changed } });
  const out = evalChat(ITEM, current, previous)!;
  const compare = replayModel(ITEM, current, previous)!.differAt! - LEAD_FRAMES;
  assert.equal(out.steps[out.differsAt!]!.transcriptIndex, compare);
  assert.equal(out.chat.segments.find((s) => s.stepIndex === out.differsAt)!.label, "select_seat");
  assert.equal(evalChat(ITEM, current, current)!.differsAt, null);
  assert.equal(evalChat(ITEM, current)!.differsAt, null);
});

test("RC-647: a result without its transcript has no chat", () => {
  assert.equal(evalChat(ITEM, result({ transcript: null })), null);
});
