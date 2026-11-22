import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReplayTranscriptStep } from "@/lib/views/eval-gate/types";
import {
  differStep,
  earlierFromSteps,
  openingWithReply,
  parseReply,
  replaySteps,
  stepCall,
  withStepAnswer,
} from "../domain/steps";

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

test("RC-641: a tool step's call is the call in the same position of the assistant step before it", () => {
  assert.deepEqual(stepCall(STEPS, 1), {
    tool: "get_seat_map",
    args: { ref: "R1" },
    content: '{"free":["23A"]}',
    isError: false,
  });
  assert.deepEqual(stepCall(STEPS, 2)!.args, { ref: "R1" });
  assert.deepEqual(stepCall(STEPS, 4)!.args, { ref: "R1", seat: "23A" });
  assert.equal(stepCall(STEPS, 0), null, "An assistant step is not a tool step.");
  assert.equal(stepCall(STEPS, 9), null);
});

test("RC-641: a step answer is a fixed answer for that tool when called with the step's arguments, and replaces the same one", () => {
  const first = withStepAnswer(
    [{ tool: "other", result: "x" }],
    stepCall(STEPS, 4)!,
    '{"error":"seat taken"}',
    "Someone took 23A",
  );
  assert.deepEqual(first, [
    { tool: "other", result: "x" },
    {
      tool: "select_seat",
      result: { error: "seat taken" },
      when: { ref: "R1", seat: "23A" },
      why: "Someone took 23A",
    },
  ]);
  const again = withStepAnswer(
    first,
    { tool: "select_seat", args: { seat: "23A", ref: "R1" } },
    "Taken",
  );
  assert.deepEqual(
    again.slice(1),
    [{ tool: "select_seat", result: "Taken", when: { ref: "R1", seat: "23A" } }],
    "Key order aside, the same call's answer is replaced.",
  );
  assert.deepEqual(
    withStepAnswer([], { tool: "ping", args: {} }, "pong"),
    [{ tool: "ping", result: "pong" }],
    "A call without arguments answers every call.",
  );
});

test("RC-641: steps 0..2 become earlier messages: the assistant's text and each answered call", () => {
  assert.deepEqual(earlierFromSteps(STEPS, 2), [
    { role: "assistant", text: "Let me look." },
    { role: "tool", tool: "get_seat_map", args: { ref: "R1" }, text: '{"free":["23A"]}' },
    { role: "tool", tool: "find_booking", args: { ref: "R1" }, text: '{"booking":"R1"}' },
  ]);
  assert.equal(earlierFromSteps(STEPS, 3).length, 3, "A call with no answer yet is left out.");
  assert.equal(earlierFromSteps(STEPS, 5).at(-1)!.text, "Seat 23A is yours.");
});

test("RC-641: the replay steps pair each tool step with its source", () => {
  const steps = replaySteps({ toolsOffered: [], steps: STEPS }, [
    { tool: "get_seat_map", source: "recorded", reason: "matched_recording", ms: 3 },
    { tool: "find_booking", source: "stand-in", reason: "stand_in_model", ms: null },
    {
      tool: "select_seat",
      source: "mock",
      reason: "fixed_answer",
      ms: null,
      why: "Someone took 23A",
    },
  ]);
  assert.deepEqual(
    steps.map((step) =>
      step.role === "tool" ? [step.index, step.tool, step.source] : [step.index, "assistant"],
    ),
    [
      [0, "assistant"],
      [1, "get_seat_map", "recorded"],
      [2, "find_booking", "stand-in"],
      [3, "assistant"],
      [4, "select_seat", "mock"],
      [5, "assistant"],
    ],
  );
  const last = steps[4]!;
  assert.ok(last.role === "tool");
  assert.deepEqual(last.args, { ref: "R1", seat: "23A" });
  assert.equal(last.why, "Someone took 23A");
  const unknown = replaySteps({ toolsOffered: [], steps: STEPS }, []);
  assert.equal(
    unknown[1]!.role === "tool" && unknown[1]!.source,
    null,
    "A run without tool answers shows no source.",
  );
});

test("RC-642: two runs differ at the first step whose call or answer is not the same", () => {
  const before = replaySteps({ toolsOffered: [], steps: STEPS }, []);
  const changed = STEPS.map((step, index) =>
    index === 4 ? ({ ...step, content: '{"error":"seat taken"}' } as ReplayTranscriptStep) : step,
  );
  assert.equal(differStep(before, replaySteps({ toolsOffered: [], steps: changed }, [])), 4);
  assert.equal(differStep(before, before), null);
  assert.equal(differStep(before, before.slice(0, 3)), 3, "A shorter run differs where it ends.");
});

test("RC-654: the opening of an edited reply is the run's steps before it, then the edited reply", () => {
  const reply = {
    text: "Let me check the seat map only.",
    calls: [{ name: "get_seat_map", args: { ref: "R1" } }],
  };
  assert.deepEqual(openingWithReply(STEPS, 3, reply), {
    ok: true,
    value: [...STEPS.slice(0, 3), { role: "assistant", ...reply }],
  });
  assert.deepEqual(openingWithReply(STEPS, 0, { text: "Hi.", calls: [] }), {
    ok: true,
    value: [{ role: "assistant", text: "Hi.", calls: [] }],
  });
  assert.deepEqual(openingWithReply(STEPS, 1, reply), {
    ok: false,
    error: "Step 1 is not an agent reply.",
  });
  assert.deepEqual(openingWithReply(STEPS, 9, reply), {
    ok: false,
    error: "Step 9 is not an agent reply.",
  });
});

test("RC-654: an edited reply needs text or a call, and each call a tool name and object arguments", () => {
  assert.deepEqual(parseReply({ text: " Done. ", calls: [] }), {
    ok: true,
    value: { text: "Done.", calls: [] },
  });
  assert.deepEqual(
    parseReply({ text: "", calls: [{ name: "select_seat", args: { seat: "1A" } }] }),
    { ok: true, value: { text: "", calls: [{ name: "select_seat", args: { seat: "1A" } }] } },
  );
  assert.deepEqual(
    parseReply({ text: "x" }),
    { ok: true, value: { text: "x", calls: [] } },
    "calls default to none",
  );
  assert.equal(parseReply({ text: "  ", calls: [] }).ok, false);
  assert.equal(parseReply({ text: "x", calls: [{ name: "", args: {} }] }).ok, false);
  assert.equal(parseReply({ text: "x", calls: [{ name: "t", args: [] }] }).ok, false);
  assert.equal(parseReply({ text: "x".repeat(20_001) }).ok, false);
  assert.equal(parseReply("nope").ok, false);
});
