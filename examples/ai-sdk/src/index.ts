import { openai } from "@ai-sdk/openai";
import { runAgent } from "./agent.js";
import { buildCatalog, tools } from "./tools.js";

const prompt =
  process.argv.slice(2).join(" ") || "read the files and find every TODO comment under src/";
const modelId = process.env.AI_MODEL ?? "gpt-5-mini";

const catalog = buildCatalog();

console.log(`prompt: "${prompt}"`);
console.log(`catalog size: ${tools.length}`);

if (!process.env.OPENAI_API_KEY) {
  const hits = catalog.search(prompt, 3);
  console.log("\n(diagnostic mode — OPENAI_API_KEY not set, skipping the model call)");
  console.log(`initial top-3 (Ratel BM25): ${hits.map((h) => h.toolId).join(", ") || "(none)"}`);
  console.log("always-present: search_tools, invoke_tool");
  process.exit(0);
}

console.log(`model: ${modelId}\n`);

const result = await runAgent({
  prompt,
  model: openai(modelId),
  catalog,
});

console.log(`\nsteps: ${result.steps}`);
console.log(`finish reason: ${result.finishReason}`);
console.log("\nmodel output:");
console.log(result.text || "(no final text — agent stopped after tool execution)");
