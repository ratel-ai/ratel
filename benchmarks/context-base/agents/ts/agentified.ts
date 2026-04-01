import { config } from "dotenv";
config();
config({ path: "../../.env" });

import { resolve } from "node:path";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { Agentified } from "agentified";
import type { BackendTool } from "agentified";
import { mastra, type MastraInstance } from "@agentified/mastra";
import { jsonSchemaToZod } from "../../lib/json-schema-to-zod.js";
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
  ag: Agentified;
  instance: MastraInstance;
  mastraAgent: Agent;
  mastraTools: Record<string, ReturnType<typeof createTool>>;
  container?: StartedTestContainer;
}

async function boot(): Promise<BootResult> {
  const scriptsDir = resolve(import.meta.dirname, "../../tools/scripts");

  // Build BackendTool[] for registration
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

  // Resolve agentified-core endpoint (external or container)
  let endpoint = process.env.AGENTIFIED_ENDPOINT;
  let container: StartedTestContainer | undefined;

  if (!endpoint) {
    console.error("[agentified] starting agentified-core container...");
    const started = await new GenericContainer("agentified/agentified-core:0.0.5-beta.6")
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

  const ag = new Agentified();
  ag.connect(endpoint);
  const mag = ag.adaptTo(mastra());
  const instance = await mag.register({ tools: backendTools });
  console.error(`[agentified] registered ${backendTools.length} tools`);

  // Build Mastra-compatible tools from definitions
  const mastraTools: Record<string, ReturnType<typeof createTool>> = {};
  for (const t of backendTools) {
    mastraTools[t.name] = createTool({
      id: t.name,
      description: t.description,
      inputSchema: jsonSchemaToZod(t.parameters),
      execute: async (input) => t.handler(input as Record<string, unknown>),
    });
  }

  return { ag, instance, mastraAgent, mastraTools, container };
}

if (process.argv[1]?.endsWith("agentified.ts") || process.argv[1]?.endsWith("agentified.js")) {
  const bootPromise = boot();

  process.on("SIGTERM", async () => {
    const result = await bootPromise.catch(() => ({ ag: undefined, container: undefined }) as any);
    if (result.ag) await result.ag.disconnect().catch(() => { });
    if (result.container) {
      console.error("[agentified] stopping container...");
      await result.container.stop().catch(() => { });
    }
    process.exit(0);
  });

  startAgent({
    setup: async () => { },

    sendMessage: async (body: SendMessageBody): Promise<SendMessageResponse> => {
      const { instance, mastraAgent, mastraTools } = await bootPromise;

      const sessionId = body.turnId ?? `turn-${Date.now()}`;
      const session = instance.session(sessionId);

      mastraAgent.__setTools({ ...mastraTools, agentified_discover: session.discoverTool });

      const result = await mastraAgent.generate(
        body.history.map((m) => ({ role: m.role, content: m.content })) as any,
        { prepareStep: session.prepareStep, maxSteps: MAX_STEPS },
      );

      const toolCalls = result.toolCalls.map((tc) => ({
        toolCallId: tc.payload.toolCallId,
        toolName: tc.payload.toolName,
        args: tc.payload.args ?? {},
      }));

      const hydratedTools = toolCalls.map((tc) => tc.toolName);

      return {
        content: result.text,
        toolCalls,
        usage: {
          totalTokens: result.usage.totalTokens ?? 0,
          inputTokens: result.usage.inputTokens ?? 0,
          outputTokens: result.usage.outputTokens ?? 0,
        },
        durationMs: 0,
        hydratedTools,
        turnId: sessionId,
        debug: {
          systemPrompt: SYSTEM_PROMPT,
          toolNames: hydratedTools,
          modelResponse: result.text,
          toolCallsMade: toolCalls.map((tc) => ({ name: tc.toolName, args: tc.args })),
        },
      };
    },
  });
}
