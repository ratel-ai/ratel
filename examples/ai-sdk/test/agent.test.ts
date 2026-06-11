// Framework-integration test for the Vercel AI SDK wiring (the TS analogue of
// examples/pydantic-ai/test_agent.py). Drives the real `ToolLoopAgent` loop with a
// scripted MockLanguageModelV3 — no API key, no network — so it exercises the parts
// that break on SDK/AI-SDK drift but the SDK-level e2e can't see:
//   - toAISDKTool bridging the SDK's JSON-Schema tool defs into `tool()`/`jsonSchema()`
//   - the gateway tools (search_tools / invoke_tool) registering + being invoked
//   - argument marshaling + result flow through the agent's tool loop
//
// Run: `tsx test/agent.test.ts` (the `example` CI job builds @ratel-ai/sdk first).
import assert from "node:assert/strict";

import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModel } from "ai";

import { runAgent } from "../src/agent.js";
import { buildCatalog } from "../src/tools.js";

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
  const model = new MockLanguageModelV3({
    // one provider result per agent step; consumed in order
    doGenerate: [
      toolCall("search_tools", { query: "read a file from local disk", topK: 3 }),
      toolCall("invoke_tool", { toolId: "read_file", args: { path: "/tmp/x" } }),
      finalText("done: read the file"),
    ] as unknown as ConstructorParameters<typeof MockLanguageModelV3>[0]["doGenerate"],
  });

  const result = await runAgent({
    prompt: "read a file from local disk",
    model: model as unknown as LanguageModel,
    catalog: buildCatalog(),
    initialTopK: 3,
    maxSteps: 8,
  });

  // The gateway tools must have been wired in...
  assert.ok(result.activeTools.includes("search_tools"), "search_tools not registered");
  assert.ok(result.activeTools.includes("invoke_tool"), "invoke_tool not registered");
  // ...the model must have driven at least the two tool steps...
  assert.ok(result.steps >= 2, `expected >=2 steps, got ${result.steps}`);
  // ...and the loop must have run our tools to completion.
  assert.equal(result.finishReason, "stop", `unexpected finishReason: ${result.finishReason}`);
  assert.ok(result.text.includes("done"), `unexpected final text: ${result.text}`);
  // The mock must have actually been consumed (proves the loop, not a short-circuit).
  assert.ok(model.doGenerateCalls.length >= 2, "model was not driven through the tool loop");

  console.log(
    `PASS (ai-sdk example): ${result.steps} steps, tools=[${result.activeTools.join(", ")}], text=${JSON.stringify(result.text)}`,
  );
}

main().catch((err) => {
  console.error("FAIL (ai-sdk example):", err);
  process.exit(1);
});
