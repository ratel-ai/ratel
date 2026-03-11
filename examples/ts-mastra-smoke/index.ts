// Mastra adapter smoke test — requires agentified-core running on localhost:9119
import dotenv from "dotenv";
dotenv.config({ path: "../../.env" });
import { tool } from "agentified";
import type { ServerTool } from "agentified";
import { AgentifiedMastra } from "@agentified/mastra";
import { Agent } from "@mastra/core/agent";
import { openai } from "@ai-sdk/openai";
import { firstValueFrom, toArray } from "rxjs";

const SERVER = process.env.AGENTIFIED_URL ?? "http://localhost:9119";

// ── Tools ──────────────────────────────────────────────────────────────

const weatherTool = tool({
  name: "get_weather",
  description: "Get current weather for a city",
  parameters: {
    type: "object",
    properties: { city: { type: "string", description: "City name" } },
    required: ["city"],
  },
});

const searchTool = tool({
  name: "search_docs",
  description: "Search documentation by keyword",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "Search query" } },
    required: ["query"],
  },
});

const tools: ServerTool[] = [weatherTool, searchTool];

const toolHandlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
  get_weather: async (args) => ({ temp: 22, city: args.city, unit: "C", condition: "sunny" }),
  search_docs: async (args) => ({ results: [`Doc about ${args.query}`] }),
};

// ── Agent ──────────────────────────────────────────────────────────────

const agent = new Agent({
  name: "smoke-test",
  instructions: "You are a helpful assistant. Use tools when asked about weather or docs.",
  model: openai("gpt-4o-mini"),
});

// ── AgentifiedMastra ───────────────────────────────────────────────────

const ag = new AgentifiedMastra({
  agentifiedUrl: SERVER,
  tools,
  toolHandlers,
  agent,
});

// ── Smoke test ─────────────────────────────────────────────────────────

async function main() {
  console.log(`Mastra smoke test — server: ${SERVER}\n`);

  // 1. Register
  const reg = await ag.register();
  console.log(`[1] register: ${reg.registered} tools registered`);
  assert(reg.registered >= 2, `expected >=2 registered, got ${reg.registered}`);

  // 2. generate() — simple text
  const r1 = await ag.generate({
    messages: [{ role: "user", content: "Say hello in one sentence." }],
  });
  console.log(`[2] generate (text): "${r1.text.slice(0, 80)}..." (${r1.durationMs.toFixed(0)}ms)`);
  assert(r1.text.length > 0, "expected non-empty text");

  // 3. generate() — trigger tool call
  const r2 = await ag.generate({
    messages: [{ role: "user", content: "What's the weather in Rome?" }],
  });
  const weatherCalls = r2.toolCalls.filter((tc) => tc.toolName === "get_weather");
  console.log(`[3] generate (tool): ${r2.toolCalls.length} tool calls, weather=${weatherCalls.length}`);
  console.log(`    text: "${r2.text.slice(0, 100)}..."`);
  assert(weatherCalls.length > 0, "expected get_weather tool call");

  // 4. generate() with debug
  const r3 = await ag.generate({
    messages: [{ role: "user", content: "Search docs about TypeScript." }],
    debug: true,
  });
  console.log(`[4] generate (debug): ${r3.debugLog?.length ?? 0} debug entries`);
  assert((r3.debugLog?.length ?? 0) > 0, "expected debug log entries");

  // 5. run() — collect Observable events
  const observable = await ag.run({
    messages: [{ role: "user", content: "What's the weather in Paris?" }],
  });
  const events = await firstValueFrom(observable.pipe(toArray()));
  const eventTypes = events.map((e) => e.type);
  console.log(`[5] run(): ${events.length} events — types: ${[...new Set(eventTypes)].join(", ")}`);
  assert(eventTypes.includes("RUN_STARTED"), "expected RUN_STARTED event");
  assert(eventTypes.includes("CUSTOM"), "expected CUSTOM prefetch event");

  // 6. generate() with turnId — session continuity
  const r4 = await ag.generate({
    messages: [{ role: "user", content: "What's the weather in Berlin?" }],
    turnId: r2.turnId,
  });
  console.log(`[6] generate (turnId): turnId=${r4.turnId ?? "none"}, tools=${r4.hydratedTools.join(",")}`);
  assert(r4.text.length > 0, "expected non-empty text with turnId");

  // 7. generate() — discover tool invocation (LLM picks from registry)
  const r5 = await ag.generate({
    messages: [{ role: "user", content: "Search for documentation about React hooks." }],
    debug: true,
  });
  const searchCalls = r5.toolCalls.filter((tc) => tc.toolName === "search_docs");
  console.log(`[7] generate (discover): ${searchCalls.length} search_docs calls, text="${r5.text.slice(0, 80)}..."`);
  assert(searchCalls.length > 0, "expected search_docs tool call");

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
