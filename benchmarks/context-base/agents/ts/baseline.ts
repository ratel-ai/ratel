import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { jsonSchemaToZod } from "@agentified/mastra";
import { toMastraModel } from "../../lib/model.js";
import { startAgent, type ExecutableTool } from "../../scaffolding/ts/index.js";
import type { SetupBody, SendMessageBody, SendMessageResponse } from "../../lib/protocol.js";

interface State {
  agent: Agent;
  tools: Record<string, any>;
  config: SetupBody["config"];
}

export function createCallbacks() {
  let state: State | undefined;

  return {
    setup: async (tools: ExecutableTool[], config: SetupBody["config"]) => {
      const mastraTools: Record<string, any> = {};
      for (const t of tools) {
        mastraTools[t.name] = createTool({
          id: t.name,
          description: t.description,
          inputSchema: jsonSchemaToZod(t.parameters),
          execute: async (input) => t.execute(input as Record<string, unknown>),
        });
      }

      const agent = new Agent({
        id: "benchmark-baseline",
        name: "benchmark-baseline",
        instructions: config.systemPrompt,
        model: toMastraModel(config.model),
      });
      (agent as any).__setTools(mastraTools);

      state = { agent, tools: mastraTools, config };
    },

    sendMessage: async (body: SendMessageBody): Promise<SendMessageResponse> => {
      if (!state) throw new Error("Agent not set up");
      const start = performance.now();

      const messages: Array<{ role: "user" | "assistant"; content: string }> = body.history.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

      const result = await state.agent.generate(messages as any, {
        maxSteps: state.config.maxSteps,
        ...(body.seed !== undefined && { seed: body.seed }),
      });

      const toolCalls = (result.steps ?? []).flatMap((step) =>
        (step.toolCalls ?? []).map((tc: any) => {
          const name = tc.toolName ?? tc.payload?.toolName;
          const id = tc.toolCallId ?? tc.payload?.toolCallId;
          const args = tc.args ?? tc.payload?.args ?? {};
          return { toolCallId: id, toolName: name, args };
        }),
      );

      const usage: any = result.usage ?? {};
      const inputTokens = usage.inputTokens ?? usage.promptTokens ?? 0;
      const outputTokens = usage.outputTokens ?? usage.completionTokens ?? 0;

      return {
        content: result.text,
        toolCalls,
        usage: {
          totalTokens: inputTokens + outputTokens,
          inputTokens,
          outputTokens,
          cachedInputTokens: usage.cachedInputTokens ?? undefined,
          outputReasoningTokens: usage.reasoningTokens ?? undefined,
        },
        durationMs: performance.now() - start,
        debug: {
          systemPrompt: state.config.systemPrompt,
          toolNames: Object.keys(state.tools),
          modelResponse: result.text,
          toolCallsMade: toolCalls.map((tc) => ({ name: tc.toolName, args: tc.args })),
        },
      };
    },
  };
}

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const cbs = createCallbacks();
  startAgent({ setup: cbs.setup, sendMessage: cbs.sendMessage });
}

