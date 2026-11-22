import assert from "node:assert/strict";
import { test } from "node:test";
import type { EvalToolAnswer, EvalTranscript } from "../domain/types";
import { frameLabel, LEAD_FRAMES, replayModel } from "../replay-view";

const TRANSCRIPT: EvalTranscript = {
  toolsOffered: ["select_seat"],
  steps: [
    { role: "assistant", text: "", calls: [{ name: "select_seat", args: { seat: "23A" } }] },
    { role: "tool", tool: "select_seat", content: '{"seat":"23A"}', isError: false },
    { role: "assistant", text: "Seat 23A is yours.", calls: [] },
  ],
};
const ANSWERS: EvalToolAnswer[] = [
  { tool: "select_seat", source: "recorded", reason: "matched_recording", ms: 5 },
];
const ITEM = {
  systemPrompt: "You are a travel agent.",
  message: "Pick seat 23A",
  generated: ["systemPrompt" as const],
};

test("RC-642: the frames are the system prompt, the message, then each step with its source; generated inputs are marked", () => {
  const model = replayModel(ITEM, { transcript: TRANSCRIPT, toolAnswers: ANSWERS })!;
  assert.deepEqual(model.frames.map(frameLabel), [
    "System prompt",
    "Message",
    "Agent calls select_seat",
    "select_seat answers",
    "Agent replies",
  ]);
  assert.deepEqual(
    model.frames.slice(0, 2).map((frame) => "generated" in frame && frame.generated),
    [true, false],
  );
  const tool = model.frames[3]!;
  assert.ok(tool.kind === "tool");
  assert.deepEqual([tool.step, tool.source, tool.args], [1, "recorded", '{\n  "seat": "23A"\n}']);
  assert.equal(model.differAt, null);
  assert.equal(model.previousFrames, null);
});

test("RC-642: against the previous run, the marker sits at the first frame that differs", () => {
  const changed: EvalTranscript = {
    ...TRANSCRIPT,
    steps: TRANSCRIPT.steps.map((step, index) =>
      index === 1 ? ({ ...step, content: '{"error":"taken"}' } as typeof step) : step,
    ),
  };
  const model = replayModel(
    ITEM,
    {
      transcript: changed,
      toolAnswers: [{ ...ANSWERS[0]!, source: "mock", reason: "fixed_answer" }],
    },
    { transcript: TRANSCRIPT, toolAnswers: ANSWERS },
  )!;
  assert.equal(model.differAt, LEAD_FRAMES + 1);
  assert.equal(model.previousFrames!.length, model.frames.length);
});

test("RC-642: a result without text has no replay", () => {
  assert.equal(replayModel(ITEM, { transcript: null, toolAnswers: ANSWERS }), null);
});
