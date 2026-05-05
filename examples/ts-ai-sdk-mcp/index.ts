/**
 * AI SDK + MCP Tools + Agentified — end-to-end example
 *
 * This example shows how an AI agent (Claude via AI SDK) can use tools
 * hosted on a remote MCP server, with Agentified handling tool registration
 * and intelligent discovery.
 *
 * Flow:
 *   1. Start a dummy MCP server (HR knowledge base with employee/department tools)
 *   2. Use mcpTools() to fetch tools from the MCP server
 *   3. Register them (+ a local backend tool) with Agentified via the AI SDK adapter
 *   4. Let the agent answer questions by discovering and calling the right tools
 *
 * Prerequisites:
 *   - agentified-core running (default: http://localhost:9119)
 *   - ANTHROPIC_API_KEY in ../../.env  (or OPENAI_API_KEY if you switch the model)
 *   - npm install / pnpm install in this directory
 *
 * Run:
 *   npx tsx index.ts
 */

import dotenv from "dotenv";
dotenv.config({ path: "../../.env" });

import { Agentified, mcpTools } from "agentified";
import type { BackendTool } from "agentified";
import { aiSdk } from "@agentified/ai-sdk";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText, stepCountIs } from "ai";
import { startMcpServer, MCP_URL } from "./mcp-server.js";

const AGENTIFIED_URL = process.env.AGENTIFIED_URL ?? "http://localhost:9119";
const MODEL = anthropic("claude-sonnet-4-20250514");

// ── Local backend tool (not MCP) ─────────────────────────────────────────

const localTools: BackendTool[] = [
  {
    name: "current_date",
    description: "Return today's date in ISO format.",
    parameters: { type: "object", properties: {} },
    handler: async () => ({ date: new Date().toISOString().split("T")[0] }),
  },
];

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  // 1. Start the dummy MCP server
  const mcpServer = await startMcpServer();

  try {
    // 2. Connect to Agentified and fetch MCP tools
    console.log(`\n[agentified] Connecting to ${AGENTIFIED_URL}`);
    const ag = new Agentified();
    await ag.connect(AGENTIFIED_URL);
    const aag = ag.adaptTo(aiSdk());

    console.log(`[mcpTools]   Fetching tools from ${MCP_URL}`);
    const mcp = await mcpTools({ server: MCP_URL });
    console.log(`[mcpTools]   Found ${mcp.length} MCP tools: ${mcp.map((t) => t.name).join(", ")}`);

    // 3. Register all tools (MCP + local backend)
    const allTools = [...mcp, ...localTools];
    const instance = await aag.register({ tools: allTools });
    console.log(`[register]   ${allTools.length} tools registered to dataset "${instance.datasetId}"\n`);

    // ── Scenario A: Direct tool use ───────────────────────────────────
    // The agent has all tools available and can call them directly.

    console.log("━".repeat(60));
    console.log("Scenario A: Direct tool use (agent has all tools)");
    console.log("━".repeat(60));

    const sessionA = instance.session("scenario-a");
    const rA = await generateText({
      model: MODEL,
      tools: sessionA.tools,
      prepareStep: sessionA.prepareStep,
      stopWhen: stepCountIs(10),
      prompt:
        "Who is Alice and what department is she in? Also, how many people are in that department?",
    });

    printResult(rA);

    // ── Scenario B: Tool discovery ────────────────────────────────────
    // The agent starts with only the discover tool. It searches for
    // relevant tools, then uses them to answer the question.

    console.log("\n" + "━".repeat(60));
    console.log("Scenario B: Tool discovery (agent discovers what it needs)");
    console.log("━".repeat(60));

    const sessionB = instance.session("scenario-b");
    const ctx = await sessionB.context
      .tools({ agentified_discover: sessionB.discoverTool })
      .assemble();

    const rB = await generateText({
      model: MODEL,
      tools: ctx.tools,
      prepareStep: ctx.prepareStep,
      stopWhen: stepCountIs(10),
      prompt: "List all departments in the company and tell me which one has the most people.",
    });

    printResult(rB);
    await ctx.flushMessages(rB.steps);

    // ── Scenario C: Multi-source (MCP + local backend) ────────────────
    // The agent combines MCP tools with a local backend tool.

    console.log("\n" + "━".repeat(60));
    console.log("Scenario C: Multi-source (MCP + local backend tool)");
    console.log("━".repeat(60));

    const sessionC = instance.session("scenario-c");
    const rC = await generateText({
      model: MODEL,
      tools: sessionC.tools,
      prepareStep: sessionC.prepareStep,
      stopWhen: stepCountIs(10),
      prompt: "What is today's date, and when did Bob start at the company?",
    });

    printResult(rC);

    await ag.disconnect();
    console.log("\n[done] All scenarios completed successfully.");
  } finally {
    mcpServer.close();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function printResult(r: Awaited<ReturnType<typeof generateText>>) {
  const calls = r.steps.flatMap((s) => s.toolCalls);
  if (calls.length > 0) {
    console.log(`\n  Tool calls (${calls.length}):`);
    for (const tc of calls) {
      console.log(`    -> ${tc.toolName}(${JSON.stringify(tc.args)})`);
    }
  }
  console.log(`\n  Agent response:\n    ${r.text.replace(/\n/g, "\n    ")}`);
}

main().catch((err) => {
  console.error("\nFATAL:", err);
  process.exit(1);
});
