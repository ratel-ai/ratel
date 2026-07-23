import { buildView, runAgent } from "./agent.js";
import { tools } from "./tools.js";

const prompt =
  process.argv.slice(2).join(" ") || "read the file at /tmp/notes.md and summarize its TODOs";
// A Mastra model-router id: no provider SDK dependency, resolves the key from env
// (e.g. OPENAI_API_KEY for an `openai/*` id). Override with MASTRA_MODEL.
const modelId = process.env.MASTRA_MODEL ?? "openai/gpt-4o-mini";

const view = buildView({ method: "bm25" });

console.log(`prompt: "${prompt}"`);
console.log(`catalog: ${Object.keys(tools).length} app tools behind 3 capability tools`);

if (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
  const hits = view.tools.catalog.search(prompt, 3, "direct");
  console.log("\n(diagnostic mode — no model API key set, skipping the model call)");
  console.log(`initial top-3 (Ratel BM25): ${hits.map((h) => h.toolId).join(", ") || "(none)"}`);
  console.log("always-present: search_capabilities, invoke_tool, get_skill_content");
  process.exit(0);
}

console.log(`model: ${modelId}\n`);

const result = await runAgent({ prompt, model: modelId, view });

console.log(`exposed tools: ${result.exposedTools.join(", ")}`);
console.log("\nmodel output:");
console.log(result.text || "(no final text — agent stopped after tool execution)");
