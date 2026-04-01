// AI SDK adapter smoke test — requires agentified-core running on localhost:9119
import dotenv from "dotenv";
dotenv.config({ path: "../../.env" });
import { Agentified } from "agentified";
import type { BackendTool } from "agentified";
import { aiSdk } from "@agentified/ai-sdk";
import { openai } from "@ai-sdk/openai";
import { generateText, stepCountIs } from "ai";

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

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  console.log(`AI SDK smoke test — server: ${SERVER}\n`);

  const ag = new Agentified();
  await ag.connect(SERVER);
  const aag = ag.adaptTo(aiSdk());

  // 1. Register
  const instance = await aag.register({ tools: toolDefs });
  console.log(`[1] register: instance=${instance.instanceId}`);
  assert(!!instance.instanceId, "expected instanceId");

  // 2. Generate — simple text response (no tool calling)
  const session2 = instance.session("smoke-text");
  const r1 = await generateText({
    model: openai("gpt-4o-mini"),
    prompt: "Say hello in one sentence.",
  });
  console.log(`[2] generate (text): "${r1.text.slice(0, 80)}..."`);
  assert(r1.text.length > 0, "expected non-empty text");

  // 3. Generate — tool call via prepareStep
  const session3 = instance.session("smoke-weather");
  const r2 = await generateText({
    model: openai("gpt-4o-mini"),
    tools: session3.tools,
    prepareStep: session3.prepareStep,
    stopWhen: stepCountIs(10),
    prompt: "What's the weather in Rome?",
  });
  const weatherCalls = r2.steps.flatMap((s) => s.toolCalls).filter((tc) => tc.toolName === "get_weather");
  console.log(`[3] generate (tool): ${weatherCalls.length} get_weather calls`);
  console.log(`    text: "${r2.text.slice(0, 100)}..."`);
  assert(weatherCalls.length > 0, "expected get_weather tool call");
  await session3.flushMessages(r2.steps);

  // 4. Generate — context chain with discover
  const session4 = instance.session("smoke-discover");
  const ctx = await session4.context
    .tools({ agentified_discover: session4.discoverTool })
    .assemble();
  const r3 = await generateText({
    model: openai("gpt-4o-mini"),
    tools: ctx.tools,
    prepareStep: ctx.prepareStep,
    stopWhen: stepCountIs(10),
    prompt: "Search for documentation about React hooks.",
  });
  const searchCalls = r3.steps.flatMap((s) => s.toolCalls).filter((tc) => tc.toolName === "search_docs");
  console.log(`[4] generate (discover): ${searchCalls.length} search_docs calls`);
  console.log(`    text: "${r3.text.slice(0, 80)}..."`);
  assert(searchCalls.length > 0, "expected search_docs tool call");
  await ctx.flushMessages(r3.steps);

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
