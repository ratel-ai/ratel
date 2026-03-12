// Mastra adapter smoke test — requires agentified-core running on localhost:9119
import dotenv from "dotenv";
dotenv.config({ path: "../../.env" });
import { Agentified } from "agentified";
import type { BackendTool } from "agentified";
import { mastra } from "@agentified/mastra";
import { Agent } from "@mastra/core/agent";
import { openai } from "@ai-sdk/openai";

const SERVER = process.env.AGENTIFIED_URL ?? "http://localhost:9119";

// ── Tools ──────────────────────────────────────────────────────────────

const toolDefs: BackendTool[] = [
  {
    name: "get_weather",
    description: "Get current weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string", description: "City name" } },
      required: ["city"],
    },
    handler: async (args) => ({ temp: 22, city: args.city, unit: "C", condition: "sunny" }),
  },
  {
    name: "search_docs",
    description: "Search documentation by keyword",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Search query" } },
      required: ["query"],
    },
    handler: async (args) => ({ results: [`Doc about ${args.query}`] }),
  },
];

// ── Agent ──────────────────────────────────────────────────────────────

const agent = new Agent({
  id: "smoke-test",
  name: "smoke-test",
  instructions:
    "You are a helpful assistant. When asked about weather, docs, or anything that requires a tool, " +
    "first use agentified_discover to find relevant tools, then call them.",
  model: openai("gpt-4o-mini"),
});

// ── Setup ──────────────────────────────────────────────────────────────

async function main() {
  console.log(`Mastra smoke test — server: ${SERVER}\n`);

  const ag = new Agentified();
  await ag.connect(SERVER);
  const mag = ag.adaptTo(mastra());

  // 1. Register
  const instance = await mag.register({ tools: toolDefs });
  console.log(`[1] register: instance=${instance.instanceId}`);
  assert(!!instance.instanceId, "expected instanceId");

  // 2. Generate — simple text response
  const session2 = instance.session("smoke-text");
  const r1 = await agent.generate(
    [{ role: "user" as const, content: "Say hello in one sentence." }],
    { prepareStep: session2.prepareStep({ tools: { agentified_discover: session2.discoverTool } }), maxSteps: 10 },
  );
  console.log(`[2] generate (text): "${r1.text.slice(0, 80)}..."`);
  assert(r1.text.length > 0, "expected non-empty text");

  // 3. Generate — discover + tool call (get_weather)
  const session3 = instance.session("smoke-weather");
  const r2 = await agent.generate(
    [{ role: "user" as const, content: "What's the weather in Rome?" }],
    { prepareStep: session3.prepareStep({ tools: { agentified_discover: session3.discoverTool } }), maxSteps: 10 },
  );
  const weatherCalls = r2.toolCalls.filter((tc) => tc.payload.toolName === "get_weather");
  console.log(`[3] generate (tool): ${r2.toolCalls.length} tool calls, weather=${weatherCalls.length}`);
  console.log(`    text: "${r2.text.slice(0, 100)}..."`);
  assert(weatherCalls.length > 0, "expected get_weather tool call");

  // 4. Generate — discover-only (no tools pre-set on agent)
  const session4 = instance.session("smoke-discover");
  const r3 = await agent.generate(
    [{ role: "user" as const, content: "Search for documentation about React hooks." }],
    { prepareStep: session4.prepareStep(), maxSteps: 10 },
  );
  const searchCalls = r3.toolCalls.filter((tc) => tc.payload.toolName === "search_docs");
  console.log(`[4] generate (discover): ${searchCalls.length} search_docs calls, text="${r3.text.slice(0, 80)}..."`);
  assert(searchCalls.length > 0, "expected search_docs tool call");

  await ag.disconnect();
  console.log("\n--- All checks passed! ---");
}

main().catch((err) => {
  console.error("\nFAILED:", err);
  process.exit(1);
});

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}
