import { config } from "dotenv";
config();
config({ path: "../../.env" });

import { resolve } from "node:path";
import { Agent } from "@mastra/core/agent";
import { tool } from "@agentified/sdk";
import { AgentifiedMastra } from "@agentified/mastra";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { z } from "zod";
import { startAgent, executeTool } from "../../scaffolding/ts/index.js";
import { toolRegistry } from "../../tools/registry.js";
import { TOOL_DEPENDENCIES } from "../../tools/dependencies.js";
import { toMastraModel } from "../../lib/model.js";
import { MODEL, SYSTEM_PROMPT, MAX_STEPS } from "../../lib/constants.js";
import type { SendMessageBody, SendMessageResponse } from "../../lib/protocol.js";

const TOOL_LIMIT = process.env.FORCE_DISCOVERY === "1" ? 0 : 15;

interface BootResult {
  agentified: AgentifiedMastra;
  container?: StartedTestContainer;
}

async function boot(): Promise<BootResult> {
  const scriptsDir = resolve(import.meta.dirname, "../../tools/scripts");

  // Build SDK tools + handlers from registry
  const sdkTools = Object.entries(toolRegistry).map(([name, t]) =>
    tool({
      name,
      description: (t as any).description ?? "",
      parameters: z.toJSONSchema((t as any).inputSchema) as Record<string, unknown>,
      ...(TOOL_DEPENDENCIES[name] && { metadata: TOOL_DEPENDENCIES[name] }),
    }),
  );

  const toolHandlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {};
  for (const name of Object.keys(toolRegistry)) {
    const script = resolve(scriptsDir, `${name}.sh`);
    toolHandlers[name] = (args) => executeTool(script, args);
  }

  // Resolve agentified-core endpoint (external or container)
  let endpoint = process.env.AGENTIFIED_ENDPOINT;
  let container: StartedTestContainer | undefined;

  if (!endpoint) {
    console.error("[agentified] starting agentified-core container...");
    const started = await new GenericContainer("agentified/agentified-core:0.2.0-beta.1")
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

  const model = process.env.MODEL ?? MODEL;
  const mastraAgent = new Agent({
    id: "benchmark-agentified",
    name: "benchmark-agentified",
    instructions: SYSTEM_PROMPT,
    model: toMastraModel(model),
  });

  const agentified = new AgentifiedMastra({
    agentifiedUrl: endpoint,
    tools: sdkTools,
    toolHandlers,
    agent: mastraAgent as any,
  });

  await agentified.register();
  console.error(`[agentified] registered ${sdkTools.length} tools`);

  return { agentified, container };
}

if (process.argv[1]?.endsWith("agentified.ts") || process.argv[1]?.endsWith("agentified.js")) {
  // Start boot immediately — sendMessage awaits the promise
  const bootPromise = boot();

  // Graceful shutdown
  process.on("SIGTERM", async () => {
    const { container } = await bootPromise.catch(() => ({ container: undefined }));
    if (container) {
      console.error("[agentified] stopping container...");
      await container.stop().catch(() => {});
    }
    process.exit(0);
  });

  startAgent({
    setup: async () => {},

    sendMessage: async (body: SendMessageBody): Promise<SendMessageResponse> => {
      const { agentified } = await bootPromise;

      const result = await agentified.generate({
        messages: body.history.map((m) => ({ role: m.role, content: m.content })),
        maxSteps: MAX_STEPS,
        turnId: body.turnId,
        toolLimit: TOOL_LIMIT,
        seed: body.seed,
        debug: !!process.env.DEBUG,
      });

      const toolCalls = result.toolCalls.map((tc) => ({
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: tc.args,
      }));

      return {
        content: result.text,
        toolCalls,
        usage: {
          totalTokens: result.usage.totalTokens,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cachedInputTokens: result.usage.cachedInputTokens,
          outputReasoningTokens: result.usage.reasoningTokens,
        },
        durationMs: result.durationMs,
        hydratedTools: result.hydratedTools,
        turnId: result.turnId,
        debug: {
          systemPrompt: SYSTEM_PROMPT,
          toolNames: result.hydratedTools ?? [],
          modelResponse: result.text,
          toolCallsMade: toolCalls.map((tc) => ({ name: tc.toolName, args: tc.args })),
          ...(result.debugLog && { agentifiedLog: result.debugLog }),
        },
      };
    },
  });
}
