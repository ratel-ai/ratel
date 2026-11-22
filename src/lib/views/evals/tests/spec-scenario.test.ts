import assert from "node:assert/strict";
import { test } from "node:test";
import type { CloudEvent, CloudMessage } from "@/lib/ingest/cloud-schema";
import type { ModelCall } from "@/lib/views/eval-gate/calls";
import { CANT_SIMULATE } from "@/lib/views/eval-gate/method";
import {
  type EvalModels,
  SpendMeter,
  standInModels,
  type ToolStandIn,
} from "@/lib/views/eval-gate/models";
import { replayAsRecorded } from "@/lib/views/eval-gate/replay";
import type { RunRecord, ToolDef } from "@/lib/views/eval-gate/types";
import { type EvalSpec, generatedInputsOf, specOnlyReplay, specScenarioOf } from "../spec-scenario";

const TOOL: ToolDef = {
  name: "hold_fare",
  description: "Hold a fare",
  parameters: { type: "object", properties: { booking_ref: { type: "string" } } },
};
const SPEC: EvalSpec = {
  message: "Hold my fare",
  systemPrompt: "You are a travel agent.",
  tools: [TOOL],
  context: { booking_ref: "MRD4F2K9" },
  generated: ["systemPrompt", "tools", "context"],
};
const NO_SPEC: EvalSpec = {
  message: "Hold my fare",
  systemPrompt: undefined,
  tools: undefined,
  context: undefined,
  generated: undefined,
};

/** A run whose one call passes `args`; its model calls carry payloads only when `captured`. */
function run(
  args: Record<string, unknown>,
  captured: boolean,
): { run: RunRecord; calls: ModelCall[] } {
  const at = new Date(Date.UTC(2026, 10, 1));
  const ask: CloudMessage = {
    role: "user",
    content: [{ type: "text", text: "Hold my fare please" }],
  };
  const used: CloudMessage = {
    role: "assistant",
    content: [{ type: "tool_call", id: "c1", name: "hold_fare", arguments: args }],
  };
  const payload = (messages: CloudMessage[]): CloudEvent => ({
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    ts: at.toISOString(),
    system: "Recorded prompt",
    tools: [TOOL],
    messages,
    finish_reason: "stop",
  });
  const call = (messages: CloudMessage[]): ModelCall => ({
    turnId: "t1",
    occurredAt: at,
    model: "claude-sonnet-4-6",
    finishReason: "stop",
    costUsd: 0,
    latencyMs: 10,
    inputTokens: 10,
    outputTokens: 1,
    payload: captured ? payload(messages) : null,
  });
  return {
    run: {
      turnId: "t1",
      traceId: "tr",
      startedAt: at.toISOString(),
      taskId: null,
      steps: [{ kind: "invoke", ordinal: 1, targetId: "hold_fare", outcome: "ok" }],
      durationMs: 1000,
    },
    calls: [
      call([ask, used]),
      call([
        ask,
        used,
        { role: "tool", tool_call_id: "c1", content: '{"held":true}' },
        { role: "assistant", content: "Held." },
      ]),
    ],
  };
}

const deps = (models: EvalModels = standInModels(), scenario: EvalSpec = SPEC) => {
  const builder = specScenarioOf(scenario);
  return {
    models,
    spend: new SpendMeter(5),
    maxSteps: 4,
    toolDefs: new Map<string, ToolDef>(),
    trace: { keepText: true },
    ...(builder ? { scenario: builder } : {}),
  };
};

test("RC-609: a run with no captured payloads runs from the eval spec; without a spec it still refuses", async () => {
  const { run: record, calls } = run({ booking_ref: "R1" }, false);
  const outcome = await replayAsRecorded(record, calls, deps());
  assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.reason);
  assert.deepEqual(outcome.trace?.toolsOffered, ["hold_fare"]);
  assert.deepEqual(await replayAsRecorded(record, calls, deps(standInModels(), NO_SPEC)), {
    ok: false,
    reason: CANT_SIMULATE.noPrompts,
  });
});

test("RC-609: a first call with IDs the recording never shows runs with the eval context; without a spec it still refuses", async () => {
  const { run: record, calls } = run({ booking_ref: "MRD4F2K9" }, true);
  const outcome = await replayAsRecorded(record, calls, deps());
  assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.reason);
  assert.deepEqual(await replayAsRecorded(record, calls, deps(standInModels(), NO_SPEC)), {
    ok: false,
    reason: CANT_SIMULATE.ungrounded,
  });
});

test("RC-609: an eval with no source run runs from its spec alone", async () => {
  const replay = specOnlyReplay("e1", new Date());
  const outcome = await replayAsRecorded(replay.run, replay.calls, deps());
  assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.reason);
});

test("RC-609: the recording's values win; the spec fills the rest, and the context reaches the model and the stand-in", async () => {
  const { run: record, calls } = run({ booking_ref: "MRD4F2K9" }, true);
  const scenario = specScenarioOf(SPEC)!({ run: record, calls })!;
  assert.match(
    scenario.system ?? "",
    /^Recorded prompt\n\nKnown values for this request: booking_ref: MRD4F2K9\.$/,
  );
  assert.deepEqual(scenario.filled, ["context"]);
  const bare = specScenarioOf(SPEC)!({ ...specOnlyReplay("e1", new Date()) })!;
  assert.deepEqual(bare.filled, ["systemPrompt", "tools", "message", "context"]);
  assert.deepEqual(bare.history, [{ role: "user", text: "Hold my fare" }]);
  const seen: unknown[] = [];
  const tool: ToolStandIn = {
    model: "t",
    standIn: true,
    async answer(input) {
      seen.push(input.context);
      return { content: "{}", isError: false, usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
  const agent: EvalModels["agent"] = () => ({
    model: "a",
    standIn: true,
    async next(input) {
      const called = input.messages.some((message) => message.role === "tool");
      return {
        text: called ? "Done" : "",
        calls: called ? [] : [{ id: "x", name: "hold_fare", args: { booking_ref: "MRD4F2K9" } }],
        model: "a",
        latencyMs: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  });
  const replay = specOnlyReplay("e1", new Date());
  const outcome = await replayAsRecorded(
    replay.run,
    replay.calls,
    deps({ ...standInModels(), agent, tool }),
  );
  assert.equal(outcome.ok, true);
  assert.deepEqual(seen, [{ booking_ref: "MRD4F2K9" }]);
});

test("RC-609: the generated inputs a replay used are the filled ones the model wrote", () => {
  assert.deepEqual(generatedInputsOf(SPEC, specOnlyReplay("e1", new Date())), [
    "systemPrompt",
    "tools",
    "context",
  ]);
  assert.deepEqual(generatedInputsOf(SPEC, run({ booking_ref: "R1" }, true)), ["context"]);
  assert.deepEqual(generatedInputsOf(NO_SPEC, specOnlyReplay("e1", new Date())), []);
});

test("RC-642: a spec field a person edited wins over the recording; another one only fills what the recording lacks", () => {
  const { run: record, calls } = run({ booking_ref: "MRD4F2K9" }, true);
  const edited: EvalSpec = {
    ...SPEC,
    systemPrompt: "Answer in one sentence.",
    message: "Hold fare MRD4F2K9 until Friday",
    generated: ["tools", "context"],
    edited: ["systemPrompt", "message"],
  };
  const earlier = [{ role: "user" as const, text: "Hi" }];
  const later = [{ role: "user" as const, text: "Thanks" }];
  const scenario = specScenarioOf(edited)!({ run: record, calls, history: earlier, after: later })!;
  assert.match(scenario.system ?? "", /^Answer in one sentence\./);
  assert.deepEqual(
    scenario.history
      .filter((message) => message.role === "user")
      .map((message) => (message as { text: string }).text),
    ["Hi", "Hold fare MRD4F2K9 until Friday", "Thanks"],
    "Only the recorded ask changes.",
  );
  assert.ok(scenario.filled!.includes("systemPrompt") && scenario.filled!.includes("message"));
  const generated = specScenarioOf(SPEC)!({ run: record, calls })!;
  assert.match(
    generated.system ?? "",
    /^Recorded prompt/,
    "A generated prompt does not replace the recorded one.",
  );
});
