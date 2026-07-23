import { openai } from "@ai-sdk/openai";
import { createRatelView, runAgent } from "./agent.js";
import { tools } from "./tools.js";

const prompt =
  process.argv.slice(2).join(" ") || "read the files and find every TODO comment under src/";
const modelId = process.env.AI_MODEL ?? "gpt-5-mini";

const { core, view } = await createRatelView();

console.log(`prompt: "${prompt}"`);
console.log(`catalog size: ${Object.keys(tools).length}`);

if (!process.env.OPENAI_API_KEY) {
  const recall = await core.recall(prompt);
  const hits = recall?.tools.groups.flatMap((g) => g.hits.map((h) => h.toolId)) ?? [];
  console.log("\n(diagnostic mode — OPENAI_API_KEY not set, skipping the model call)");
  console.log(`recall hits (Ratel BM25): ${hits.join(", ") || "(none)"}`);
  console.log("always-present: search_capabilities, invoke_tool, get_skill_content");
  process.exit(0);
}

console.log(`model: ${modelId}\n`);

const result = await runAgent({
  prompt,
  model: openai(modelId),
  view,
});

console.log(`\nsteps: ${result.steps}`);
console.log(`finish reason: ${result.finishReason}`);
console.log("\nmodel output:");
console.log(result.text || "(no final text — agent stopped after tool execution)");
