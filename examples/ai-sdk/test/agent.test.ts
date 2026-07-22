// Framework-integration test for the Vercel AI SDK wiring (the TS analogue of
// examples/pydantic-ai/test_agent.py). Drives the real `ToolLoopAgent` loop with a
// scripted MockLanguageModelV3 — no API key, no network — so it exercises the parts
// that break on SDK/AI-SDK drift but the SDK-level e2e can't see:
//   - the adapter view ingesting AI SDK-native `tool()` defs into the catalog
//   - the capability tools (search_capabilities / invoke_tool) registering + being invoked
//   - `prepareStep` landing the per-turn recall pair in the model's prompt
//   - argument marshaling + result flow through the agent's tool loop
//
// Run: `tsx test/agent.test.ts` (the `example` CI job builds the workspace first).
import assert from "node:assert/strict";

import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModel } from "ai";

import { createRatelView, runAgent } from "../src/agent.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

let seq = 0;
function toolCall(toolName: string, input: unknown) {
  return {
    content: [
      { type: "tool-call", toolCallId: `call-${seq++}`, toolName, input: JSON.stringify(input) },
    ],
    finishReason: { unified: "tool-calls", raw: undefined },
    usage,
    warnings: [],
  };
}
function finalText(text: string) {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: undefined },
    usage,
    warnings: [],
  };
}

async function main() {
  // Scripted model: search the catalog, invoke a discovered tool, then answer.
  // One result per doGenerate call, consumed in order via an explicit function
  // (the array form's consumption semantics drifted across ai majors).
  const scripted = [
    toolCall("search_capabilities", { query: "read a file from local disk", topKTools: 3 }),
    toolCall("invoke_tool", { toolId: "read_file", args: { path: "/tmp/x" } }),
    finalText("done: read the file"),
  ];
  let scriptedIndex = 0;
  const model = new MockLanguageModelV3({
    doGenerate: (async () =>
      scripted[scriptedIndex++]) as unknown as ConstructorParameters<
      typeof MockLanguageModelV3
    >[0]["doGenerate"],
  });

  const { view } = await createRatelView();
  const result = await runAgent({
    prompt: "read a file from local disk",
    model: model as unknown as LanguageModel,
    view,
    maxSteps: 8,
  });

  // The capability tools must have been wired in...
  assert.ok(result.activeTools.includes("search_capabilities"), "search_capabilities not registered");
  assert.ok(result.activeTools.includes("invoke_tool"), "invoke_tool not registered");
  // ...the model must have driven at least the two tool steps...
  assert.ok(result.steps >= 2, `expected >=2 steps, got ${result.steps}`);
  // ...and the loop must have run our tools to completion.
  assert.equal(result.finishReason, "stop", `unexpected finishReason: ${result.finishReason}`);
  assert.ok(result.text.includes("done"), `unexpected final text: ${result.text}`);
  // The mock must have actually been consumed (proves the loop, not a short-circuit).
  assert.ok(model.doGenerateCalls.length >= 2, "model was not driven through the tool loop");
  // prepareStep must have landed the synthetic recall pair in every step's prompt.
  for (const [i, call] of model.doGenerateCalls.entries()) {
    assert.ok(
      JSON.stringify(call.prompt).includes("recall_0"),
      `recall pair missing from step ${i}'s prompt`,
    );
  }

  console.log(
    `PASS (ai-sdk example): ${result.steps} steps, tools=[${result.activeTools.join(", ")}], text=${JSON.stringify(result.text)}`,
  );
}

main().catch((err) => {
  console.error("FAIL (ai-sdk example):", err);
  process.exit(1);
});
