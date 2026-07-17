// Framework-integration test for the Mastra wiring (the analogue of
// examples/ai-sdk/test/agent.test.ts). Drives the real Mastra `Agent` loop with
// Mastra's built-in mock model — no API key, no network — so it exercises the
// parts that break on SDK/Mastra drift but the SDK-level e2e can't see:
//   - the adapter's expose() feeding the Agent exactly the three capability tools
//   - recallProcessor() injecting the synthetic search_capabilities pair into the
//     prompt the model actually receives
//
// Run: `tsx test/agent.test.ts` (the `example` CI job builds @ratel-ai/sdk and the
// adapter first). Mastra ships the mock as JS with no type declarations; this file
// is not part of the package's `tsc` include, so the plain import is fine.
import assert from "node:assert/strict";

import { createMockModel } from "@mastra/core/test-utils/llm-mock";
import { SEARCH_CAPABILITIES_ID } from "@ratel-ai/sdk";

import { buildView, runAgent } from "../src/agent.js";

async function main() {
  const view = buildView({ method: "bm25" });
  const prompts = [];
  const model = createMockModel({
    mockText: "done: read the file",
    spyGenerate: (props) => prompts.push(JSON.stringify(props.prompt)),
  });

  const result = await runAgent({ prompt: "read a file from local disk", model, view });

  // The model sees exactly Ratel's three capability tools, not the six app tools.
  assert.deepEqual(
    result.exposedTools.slice().sort(),
    ["get_skill_content", "invoke_tool", "search_capabilities"],
    `unexpected exposed tools: ${result.exposedTools.join(", ")}`,
  );
  // The loop ran to a final answer.
  assert.ok(result.text.includes("done"), `unexpected final text: ${result.text}`);
  // The mock was driven exactly once and the recall pair rode into its prompt.
  assert.equal(prompts.length, 1, "model was not called exactly once");
  assert.ok(prompts[0].includes(SEARCH_CAPABILITIES_ID), "recall pair not in the model prompt");
  assert.ok(prompts[0].includes("read a file"), "recall query not in the model prompt");

  console.log(
    `PASS (mastra example): text=${JSON.stringify(result.text)}, exposed=[${result.exposedTools.join(", ")}]`,
  );
}

main().catch((err) => {
  console.error("FAIL (mastra example):", err);
  process.exit(1);
});
