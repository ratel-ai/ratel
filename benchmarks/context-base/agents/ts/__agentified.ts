import { config } from "dotenv";
config();
config({ path: "../../.env" });

import { resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { Agentified } from "agentified";
import type { BackendTool, SearchStrategy } from "agentified";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { z } from "zod";
import { runAgenticLoop, toAnthropicTools, type AnthropicTool } from "../../lib/anthropic-agent.js";
import { startAgent, executeTool } from "../../scaffolding/ts/index.js";
import { toolRegistry } from "../../tools/registry.js";
import { TOOL_DEPENDENCIES } from "../../tools/dependencies.js";
import { MODEL, SYSTEM_PROMPT, MAX_STEPS } from "../../lib/constants.js";
import type { SendMessageBody, SendMessageResponse } from "../../lib/protocol.js";

const DISCOVER_TOOL_DEF: AnthropicTool = {
  name: "agentified_discover",
  description: "Search for available tools by describing what you need. Returns relevant tools you can use.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Description of what tools you need" },
      limit: { type: "number", description: "Max number of tools to return" },
    },
    required: ["query"],
  },
};

interface BootResult {
  ag: Agentified;
  client: Anthropic;
  allTools: AnthropicTool[];
  executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  instance: Instance;
  container?: StartedTestContainer;
}

async function boot(): Promise<BootResult> {
  const scriptsDir = resolve(import.meta.dirname, "../../tools/scripts");

  const backendTools: BackendTool[] = Object.entries(toolRegistry).map(([name, t]) => {
    const script = resolve(scriptsDir, `${name}.sh`);
    return {
      name,
      description: (t as any).description ?? "",
      parameters: z.toJSONSchema((t as any).inputSchema) as Record<string, unknown>,
      handler: (args: Record<string, unknown>) => executeTool(script, args),
      ...(TOOL_DEPENDENCIES[name] && { metadata: TOOL_DEPENDENCIES[name] }),
    };
  });

  let endpoint = process.env.AGENTIFIED_ENDPOINT;
  let container: StartedTestContainer | undefined;

  if (!endpoint) {
    console.error("[agentified] starting agentified-core container...");
    const started = await new GenericContainer("agentified/agentified-core:0.2.1-beta.1")
      .withExposedPorts(9119)
      .withEnvironment({
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
        AGENTIFIED_PORT: "9119",
      })
      .withHealthCheck({
        test: ["CMD-SHELL", "curl -f http://localhost:9119/health || exit 1"],
        interval: 2_000,
        timeout: 3_000,
        retries: 30,
        startPeriod: 5_000,
      })
      .withWaitStrategy(Wait.forHealthCheck())
      .withStartupTimeout(180_000)
      .start();

    const port = started.getMappedPort(9119);
    const host = started.getHost();
    endpoint = `http://${host}:${port}`;
    container = started;
    console.error(`[agentified] agentified-core running at ${endpoint}`);
  } else {
    console.error(`[agentified] using external endpoint: ${endpoint}`);
  }

  const strategy = (process.env.SEARCH_STRATEGY as SearchStrategy | undefined) ?? inferStrategy();
  const ag = new Agentified();
  await ag.connect(endpoint, { strategy });
  console.error(`[agentified] using search strategy: ${strategy}`);
  const instance = await ag.register({ tools: backendTools });
  console.error(`[agentified] registered ${backendTools.length} tools`);

  const discoverTool = instance.discoverTool;

  // Build Anthropic-format tools and executors
  const allTools = toAnthropicTools(backendTools);
  const executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {};
  for (const t of backendTools) executors[t.name] = t.handler;

  // Add discover tool executor
  executors["agentified_discover"] = async (args) => {
    const result = await discoverTool.execute(args as any);
    return result.map((t) => ({ name: t.name, description: t.description, score: t.score }));
  };

  const client = new Anthropic();

  return { ag, client, allTools, executors, instance, container };
}

function inferStrategy(): SearchStrategy {
  const arg1 = process.argv[1] ?? "";
  if (arg1.includes("agentified-hybrid")) return "hybrid";
  return "bm25";
}

if (/agentified(?:-(?:bm25|hybrid))?\.(?:ts|js)$/.test(process.argv[1] ?? "")) {
  const bootPromise = boot();

  process.on("SIGTERM", async () => {
    const result = await bootPromise.catch(() => ({ ag: undefined, container: undefined }) as any);
    if (result.ag) await result.ag.disconnect().catch(() => {});
    if (result.container) {
      console.error("[agentified] stopping container...");
      await result.container.stop().catch(() => {});
    }
    process.exit(0);
  });

  startAgent({
    setup: async () => {},

    sendMessage: async (body: SendMessageBody): Promise<SendMessageResponse> => {
      const { client, allTools, executors, instance } = await bootPromise;
      const start = performance.now();
      const model = process.env.MODEL ?? MODEL;

      const session = instance.session(body.turnId ?? "default");
      const discoveredNames = session.discoverTool.discoveredNames;

      // Persist the user message, then recall relevant tools via context assembly
      await session.updateConversation({
        messages: body.history.map((m) => ({ role: m.role, content: m.content })),
      });
      const ctx = await session.context
        .recall({ tools: { limit: 10 } })
        .messages({ strategy: "recent", maxTokens: 4000 })
        .assemble();

      console.error(`[agentified] recalled ${ctx.recalled.tools.length} tools: ${ctx.recalled.tools.map((t) => t.name).join(", ")}`);

      const result = await runAgenticLoop({
        client,
        model,
        system: SYSTEM_PROMPT,
        tools: buildActiveTools(allTools, discoveredNames),
        messages: body.history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
        maxSteps: MAX_STEPS,
        executors,
        beforeStep: async (step) => {
          // Update tools based on what was discovered (recall + agentified_discover)
          if (step > 0) {
            return { tools: buildActiveTools(allTools, discoveredNames) };
          }
        },
        filterReportedCalls: (calls) => calls.filter((tc) => tc.toolName !== "agentified_discover"),
      });

      return {
        content: result.content,
        toolCalls: result.toolCalls,
        usage: {
          totalTokens: result.usage.inputTokens + result.usage.outputTokens,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cachedInputTokens: result.usage.cachedInputTokens,
        },
        durationMs: performance.now() - start,
        hydratedTools: [...discoveredNames],
        turnId: body.turnId,
        debug: {
          systemPrompt: SYSTEM_PROMPT,
          toolNames: [...discoveredNames],
          modelResponse: result.content,
          toolCallsMade: result.toolCalls.map((tc) => ({ name: tc.toolName, args: tc.args })),
        },
      };
    },
  });
}

function buildActiveTools(allTools: AnthropicTool[], discoveredNames: Set<string>): AnthropicTool[] {
  const active = allTools.filter((t) => discoveredNames.has(t.name));
  return [DISCOVER_TOOL_DEF, ...active] as any;
}
