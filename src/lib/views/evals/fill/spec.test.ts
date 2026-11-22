import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelCall } from "@/lib/views/eval-gate/calls";
import { readRecording } from "@/lib/views/eval-gate/scenario";
import type { RunRecord } from "@/lib/views/eval-gate/types";
import { capturedSpecOf } from "./captured";
import { parseFilled, type SpecFiller, scriptedSpecFiller } from "./filler";
import { completeSpec, type SpecDraft } from "./spec";

const TOOL = {
  name: "find_booking",
  description: "Find a booking",
  parameters: { type: "object", properties: { ref: { type: "string" } } },
};

const empty: SpecDraft = {
  name: "Refund",
  message: "",
  criteria: "",
  expectedTool: null,
  earlierMessages: [],
  captured: null,
};

function recordingFiller(
  values: Awaited<ReturnType<SpecFiller["fill"]>>,
): SpecFiller & { asked: string[][] } {
  const asked: string[][] = [];
  return {
    model: "test",
    asked,
    async fill(request) {
      asked.push([...request.missing]);
      return values;
    },
  };
}

test("RC-608: with no recording, the filler writes every field and generated lists them", async () => {
  const filler = recordingFiller({
    systemPrompt: "You book trips.",
    message: "Refund MRD4F2K9",
    tools: [TOOL],
    context: { ref: "MRD4F2K9" },
  });
  const out = await completeSpec(empty, filler);
  assert.deepEqual(filler.asked, [["systemPrompt", "message", "tools", "context"]]);
  assert.deepEqual(out, {
    systemPrompt: "You book trips.",
    message: "Refund MRD4F2K9",
    tools: [TOOL],
    context: { ref: "MRD4F2K9" },
    generated: ["systemPrompt", "message", "tools", "context"],
  });
});

test("RC-608: captured values win: the filler writes only the missing ones", async () => {
  const filler = recordingFiller({
    systemPrompt: "made up",
    message: "made up",
    tools: [],
    context: { ref: "x1y2" },
  });
  const draft: SpecDraft = {
    ...empty,
    message: "Refund my trip",
    captured: { systemPrompt: "Recorded prompt", tools: [TOOL], context: null },
  };
  const out = await completeSpec(draft, filler);
  assert.deepEqual(filler.asked, [["context"]]);
  assert.deepEqual(out, {
    systemPrompt: "Recorded prompt",
    message: "Refund my trip",
    tools: [TOOL],
    context: { ref: "x1y2" },
    generated: ["context"],
  });
});

test("RC-608: a complete spec calls no model", async () => {
  const filler = recordingFiller({});
  const draft: SpecDraft = {
    ...empty,
    message: "Refund",
    captured: { systemPrompt: "P", tools: [TOOL], context: {} },
  };
  const out = await completeSpec(draft, filler);
  assert.deepEqual(filler.asked, []);
  assert.deepEqual(out.generated, []);
});

test("RC-608: a field the filler leaves out or gives empty is not counted as generated", async () => {
  const out = await completeSpec(empty, recordingFiller({ systemPrompt: "  ", tools: [TOOL] }));
  assert.deepEqual(out.generated, ["tools"]);
  assert.equal(out.systemPrompt, null);
  assert.equal(out.message, "");
});

test("RC-608: when the filler fails, the captured spec stays and generated is empty", async () => {
  const failing: SpecFiller = {
    model: "test",
    async fill() {
      throw new Error("boom");
    },
  };
  const out = await completeSpec(
    { ...empty, message: "Refund", captured: { systemPrompt: "P", tools: null, context: null } },
    failing,
  );
  assert.deepEqual(out, {
    systemPrompt: "P",
    message: "Refund",
    tools: null,
    context: null,
    generated: [],
  });
});

test("RC-608: no filler (no model key) keeps the captured spec", async () => {
  const out = await completeSpec(
    { ...empty, captured: { systemPrompt: "P", tools: [TOOL], context: {} } },
    null,
  );
  assert.deepEqual(out, {
    systemPrompt: "P",
    message: "",
    tools: [TOOL],
    context: {},
    generated: [],
  });
});

test("RC-608: parseFilled keeps only well-formed values", () => {
  assert.deepEqual(
    parseFilled(
      JSON.stringify({
        systemPrompt: "S",
        message: 3,
        tools: [{ name: "t" }],
        context: { a: "b", n: 1 },
      }),
    ),
    {
      systemPrompt: "S",
      tools: [{ name: "t", description: "", parameters: { type: "object", properties: {} } }],
      context: { a: "b" },
    },
  );
  assert.throws(() => parseFilled("not json"));
});

test("RC-608: the scripted stand-in writes a complete spec from the draft", async () => {
  const out = await completeSpec({ ...empty, expectedTool: "find_booking" }, scriptedSpecFiller());
  assert.deepEqual(out.generated, ["systemPrompt", "message", "tools", "context"]);
  assert.equal(out.tools?.[0]?.name, "find_booking");
  assert.ok(out.message.length > 0 && (out.systemPrompt ?? "").length > 0);
});

test("RC-608: the captured spec is the recording's prompt, tools and the IDs its first call passes unseen", () => {
  const run = {
    turnId: "t1",
    steps: [{ kind: "invoke", targetId: "find_booking", outcome: "ok" }],
    durationMs: 1000,
  } as unknown as RunRecord;
  const call = (messages: unknown[]): ModelCall => ({
    turnId: "t1",
    occurredAt: new Date(),
    model: "claude-x",
    finishReason: null,
    costUsd: null,
    latencyMs: 10,
    inputTokens: 10,
    outputTokens: 1,
    payload: {
      system: "Recorded prompt",
      tools: [TOOL],
      messages,
    } as unknown as ModelCall["payload"],
  });
  const ask = { role: "user", content: "Refund my trip" };
  const used = {
    role: "assistant",
    content: [
      { type: "tool_call", id: "c1", name: "find_booking", arguments: { ref: "MRD4F2K9" } },
    ],
  };
  const result = { role: "tool", tool_call_id: "c1", content: '{"ok":true}' };
  const recording = readRecording(run, [
    call([ask]),
    call([ask, used, result, { role: "assistant", content: "Done" }]),
  ])!;
  assert.deepEqual(capturedSpecOf(recording), {
    systemPrompt: "Recorded prompt",
    tools: [TOOL],
    context: { ref: "MRD4F2K9" },
  });
});
