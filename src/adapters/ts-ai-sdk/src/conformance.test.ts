import assert from "node:assert/strict";
import { SEARCH_CAPABILITIES_ID } from "@ratel-ai/sdk";
import {
  type AdapterConformanceOptions,
  type ConformanceToolSpec,
  describeAdapterConformance,
  type RecallExpectation,
} from "@ratel-ai/sdk/testkit";
import { jsonSchema, type ModelMessage, type Tool, tool } from "ai";
import { describe, it } from "vitest";
import { aiSdk } from "./aisdk.js";

// The framework hooks that teach the shared conformance battery how to build ai
// tools, invoke exposed ones, and read back the recall pair. Kept test-only: the
// testkit ships the reference worked example, so publishing ours would add a
// semver-bound API for zero users. Supplying makePassthroughTool means 0 skips.
function aiSdkConformanceOptions(): AdapterConformanceOptions<Tool, ModelMessage> {
  return {
    adapter: aiSdk,
    makeExecutableTool: (spec: ConformanceToolSpec) =>
      tool({
        description: spec.description,
        inputSchema: jsonSchema({ type: "object" }),
        execute: async () => spec.result ?? { ok: true },
      }),
    makePassthroughTool: (spec: ConformanceToolSpec) =>
      tool({
        description: spec.description,
        inputSchema: jsonSchema({ type: "object" }),
      }),
    callExposedTool: (t, args) => {
      const execute = t.execute as (input: unknown, options: unknown) => unknown;
      // Exposed tools ignore the options; fabricate a minimal set so the call is
      // shaped like a real ai@7 invocation.
      return execute(args, { toolCallId: "conformance", messages: [], context: undefined });
    },
    validateRecallPair,
    validateExposedTool,
  };
}

describeAdapterConformance(aiSdkConformanceOptions(), { describe, it });

// The synthetic pair is an assistant `search_capabilities` tool-call followed by
// a tool tool-result carrying the JSON-stringified recall.
function validateRecallPair(messages: ModelMessage[], expected: RecallExpectation): void {
  assert.equal(messages.length, 2, "recall pair has exactly two messages");
  const [call, result] = messages;

  assert.equal(call.role, "assistant", "first message is the assistant tool-call");
  const callPart = (call.content as Array<Record<string, unknown>>)[0];
  assert.equal(callPart.type, "tool-call");
  assert.equal(callPart.toolCallId, expected.callId, "call carries the expected id");
  assert.equal(callPart.toolName, SEARCH_CAPABILITIES_ID);
  assert.deepEqual(callPart.input, { query: expected.query }, "call carries the query");

  assert.equal(result.role, "tool", "second message is the tool result");
  const resultPart = (result.content as Array<Record<string, unknown>>)[0];
  assert.equal(resultPart.type, "tool-result");
  assert.equal(resultPart.toolCallId, expected.callId, "result shares the call id");
  assert.equal(resultPart.toolName, SEARCH_CAPABILITIES_ID);
  const output = resultPart.output as { type: string; value: string };
  assert.equal(output.type, "text", "the recall travels as a JSON text part");
  assert.deepEqual(
    JSON.parse(output.value),
    JSON.parse(JSON.stringify(expected.recall)),
    "result carries the canonical recall (round-tripped)",
  );
}

// An `expose` codec output is framework-shaped — description/execute but neither
// the `id` nor `outputSchema` of a raw ExecutableTool.
function validateExposedTool(t: Tool): void {
  assert.equal(typeof t.description, "string", "exposed tool keeps a description");
  assert.equal(typeof t.execute, "function", "exposed tool is callable");
  assert.ok(!("id" in t), "exposed tool is framework-shaped (no id)");
  assert.ok(!("outputSchema" in t), "exposed tool is framework-shaped (no outputSchema)");
}
