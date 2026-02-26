import { Agent } from "@mastra/core/agent";
import { tool } from "@agentified/sdk";
import { AgentifiedMastra } from "@agentified/mastra";
import { startAgent, type ExecutableTool } from "../../scaffolding/ts/index.js";
import type { SetupBody, SendMessageBody, SendMessageResponse } from "../../lib/protocol.js";

const TOOL_LIMIT = process.env.FORCE_DISCOVERY === "1" ? 0 : 5;

interface State {
  agentified: InstanceType<typeof AgentifiedMastra>;
  config: SetupBody["config"];
}

export function createCallbacks() {
  let state: State | undefined;

  return {
    setup: async (tools: ExecutableTool[], config: SetupBody["config"]) => {
      const sdkTools = tools.map((t) =>
        tool({
          name: t.name,
          description: t.description,
          parameters: t.parameters as Record<string, unknown>,
        }),
      );

      const toolHandlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {};
      for (const t of tools) {
        toolHandlers[t.name] = (args) => t.execute(args);
      }

      const endpoint = config.agentifiedEndpoint ?? process.env.AGENTIFIED_ENDPOINT ?? "http://localhost:9119";

      const mastraAgent = new Agent({
        id: "benchmark-agentified",
        name: "benchmark-agentified",
        instructions: config.systemPrompt,
        model: toMastraModel(config.model),
      });

      const agentified = new AgentifiedMastra({
        agentifiedUrl: endpoint,
        tools: sdkTools,
        toolHandlers,
        agent: mastraAgent as any,
      });

      await agentified.register();
      state = { agentified, config };
    },

    sendMessage: async (body: SendMessageBody): Promise<SendMessageResponse> => {
      if (!state) throw new Error("Agent not set up");

      const result = await state.agentified.generate({
        messages: body.history.map((m) => ({ role: m.role, content: m.content })),
        maxSteps: state.config.maxSteps,
        turnId: body.turnId,
        toolLimit: TOOL_LIMIT,
        seed: body.seed,
      });

      return {
        content: result.text,
        toolCalls: result.toolCalls.map((tc) => ({
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          args: tc.args,
        })),
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
      };
    },
  };
}

function toMastraModel(modelId: string): string {
  if (modelId.startsWith("gpt-")) return `openai/${modelId}`;
  if (modelId.startsWith("claude-")) return `anthropic/${modelId}`;
  if (modelId.startsWith("gemini-")) return `google/${modelId}`;
  throw new Error(`Unknown model provider for: ${modelId}`);
}

if (process.argv[1]?.endsWith("agentified.ts") || process.argv[1]?.endsWith("agentified.js")) {
  const cbs = createCallbacks();
  startAgent({ setup: cbs.setup, sendMessage: cbs.sendMessage });
}
