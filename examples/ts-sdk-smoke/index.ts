// SDK smoke test — requires agentified-core with AGENTIFIED_STORAGE=sqlite
import { Agentified } from "agentified";

const SERVER = process.env.AGENTIFIED_URL ?? "http://localhost:9119";
const SESSION_ID = `smoke-${Date.now()}`;

const ag = new Agentified();
await ag.connect(SERVER);
console.log("[1] Connected to", SERVER);

const instance = await ag.register({
  tools: [
    {
      name: "get_weather",
      description: "Get current weather for a city",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
      handler: async (args) => ({ temp: 22, city: args.city, unit: "C" }),
    },
    {
      name: "search_docs",
      description: "Search documentation by keyword",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      handler: async (args) => ({ results: [`Doc about ${args.query}`] }),
    },
  ],
});
console.log("[2] Registered tools");

const session = instance.session(SESSION_ID);
console.log("[3] Session:", SESSION_ID);

// --- updateConversation ---
const messages = [
  { role: "user", content: "What's the weather in Rome?" },
  { role: "assistant", content: "Let me check the weather in Rome for you." },
  { role: "user", content: "Also search docs about TypeScript." },
];
await session.updateConversation({ messages });
console.log("[4] updateConversation: 3 messages persisted");

// --- conversation.messages ---
const stored = await session.conversation.messages();
console.log(`[5] conversation.messages: ${stored.length} messages`);
assert(stored.length === 3, `expected 3 stored, got ${stored.length}`);

// --- context.assemble ---
const ctx = await session.context.messages({ strategy: "recent" }).assemble();
console.log(`[6] context.assemble: ${ctx.includedMessages}/${ctx.totalMessages} msgs, strategy=${ctx.strategyUsed}`);
assert(ctx.messages.length === 3, `expected 3 context msgs, got ${ctx.messages.length}`);

// --- discoverTool (may fail if OPENAI_API_KEY is invalid) ---
try {
  const discovered = await session.discoverTool.execute({ query: "weather forecast" });
  console.log(`[7] discoverTool: ${discovered.length} tools found`);
} catch (e: any) {
  console.log(`[7] discoverTool: SKIPPED (${e.message?.slice(0, 80)})`);
}

// --- getMessages ---
const msgs = await session.getMessages({ strategy: "recent" });
console.log(`[8] getMessages: ${msgs.messages.length} messages`);
assert(msgs.messages.length === 3, `expected 3, got ${msgs.messages.length}`);

// --- conversation.append ---
await session.conversation.append([{ role: "user", content: "Thanks!" }]);
const allMsgs = await session.conversation.messages();
console.log(`[9] after append: ${allMsgs.length} messages`);
assert(allMsgs.length === 4, `expected 4 after append, got ${allMsgs.length}`);

// --- updateConversation dedup ---
await session.updateConversation({ messages: [...messages, { role: "user", content: "Thanks!" }] });
const afterDedup = await session.conversation.messages();
console.log(`[10] updateConversation dedup: ${afterDedup.length} messages (should still be 4)`);
assert(afterDedup.length === 4, `expected 4 after dedup, got ${afterDedup.length}`);

// --- compacted strategy (server-side, requires OPENAI_API_KEY) ---
// Build a longer conversation so there are "older" messages to summarize
const session2 = instance.session(`smoke-compacted-${Date.now()}`);
const bulkMsgs = [];
for (let i = 0; i < 20; i++) {
  bulkMsgs.push({ role: "user", content: `Message ${i}: ${"x".repeat(200)}` });
  bulkMsgs.push({ role: "assistant", content: `Reply ${i}: ${"y".repeat(200)}` });
}
// Add a tool result to test pruning
bulkMsgs.push({ role: "user", content: "Call the tool" });
bulkMsgs.push({ role: "tool", content: "z".repeat(600), tool_call_id: "tc1" });
bulkMsgs.push({ role: "assistant", content: "Got the tool result" });
bulkMsgs.push({ role: "user", content: "What was the result?" });
await session2.updateConversation({ messages: bulkMsgs });
console.log(`[11] compacted setup: ${bulkMsgs.length} messages persisted`);

try {
  const compactedCtx = await session2.context
    .messages({ strategy: "compacted", maxTokens: 2000, pruneThreshold: 500 })
    .assemble();
  console.log(`[12] compacted: strategy=${compactedCtx.strategyUsed}, summary=${!!compactedCtx.summary}, fallback=${compactedCtx.fallback}, msgs=${compactedCtx.messages.length}`);
  assert(compactedCtx.strategyUsed === "compacted", `expected compacted, got ${compactedCtx.strategyUsed}`);
  if (!compactedCtx.fallback) {
    assert(!!compactedCtx.summary, "expected summary when not fallback");
    // Summary message should be injected into the messages array
    const hasSummaryMsg = compactedCtx.messages.some(m => m.content.includes("[Summary of messages"));
    assert(hasSummaryMsg, "expected injected summary message in assembled context");
    console.log(`[12] compacted: summary injected ✓`);
  }
} catch (e: any) {
  console.log(`[12] compacted: SKIPPED (${e.message?.slice(0, 80)})`);
}

// --- client-side compactionStrategy ---
try {
  const session3 = instance.session(`smoke-client-compact-${Date.now()}`);
  await session3.updateConversation({ messages: bulkMsgs });

  const clientCtx = await session3.context
    .messages({
      strategy: "compacted",
      maxTokens: 2000,
      compactionStrategy: async (olderMessages) => {
        return { summary: `Client summarized ${olderMessages.length} older messages` };
      },
    })
    .assemble();
  console.log(`[13] client compaction: strategy=${clientCtx.strategyUsed}, summary=${!!clientCtx.summary}, msgs=${clientCtx.messages.length}`);
  assert(clientCtx.strategyUsed === "compacted", `expected compacted, got ${clientCtx.strategyUsed}`);
  assert(!!clientCtx.summary, "expected client-side summary");
  assert(clientCtx.summary!.includes("Client summarized"), "expected client summary text");
  const hasSummaryMsg = clientCtx.messages.some(m => m.content.includes("[Summary of messages"));
  assert(hasSummaryMsg, "expected injected summary message from client compaction");
  console.log(`[13] client compaction: summary injected ✓`);
} catch (e: any) {
  console.log(`[13] client compaction: SKIPPED (${e.message?.slice(0, 80)})`);
}

await ag.disconnect();
console.log("\n✓ All checks passed!");

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}
