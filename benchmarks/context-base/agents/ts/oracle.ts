import Anthropic from "@anthropic-ai/sdk";
import { runAgenticLoop, toAnthropicTools, stripAgentifiedLine, type AnthropicTool } from "../../lib/anthropic-agent.js";
import { startAgent, type ExecutableTool } from "../../scaffolding/ts/index.js";
import { flattenSlots } from "../../lib/tool-slots.js";
import type { SetupBody, SendMessageBody, SendMessageResponse } from "../../lib/protocol.js";

interface State {
  client: Anthropic;
  tools: AnthropicTool[];
  executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  config: SetupBody["config"];
  systemPrompt: string;
}

export function createCallbacks() {
  let state: State | undefined;

  return {
    setup: async (tools: ExecutableTool[], config: SetupBody["config"]) => {
      const client = new Anthropic();
      const executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {};
      for (const t of tools) executors[t.name] = t.execute;

      state = {
        client,
        tools: toAnthropicTools(tools),
        executors,
        config,
        systemPrompt: stripAgentifiedLine(config.systemPrompt),
      };
    },

    sendMessage: async (body: SendMessageBody): Promise<SendMessageResponse> => {
      if (!state) throw new Error("Agent not set up");
      const start = performance.now();

      // Filter tools to only expected ones (oracle knowledge)
      const flatExpected = body.expectedTools ? flattenSlots(body.expectedTools) : undefined;
      const activeTools = flatExpected
        ? state.tools.filter((t) => flatExpected.includes(t.name))
        : state.tools;

      const result = await runAgenticLoop({
        client: state.client,
        model: state.config.model,
        system: state.systemPrompt,
        tools: activeTools as any,
        messages: body.history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
        maxSteps: state.config.maxSteps,
        executors: state.executors,
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
        hydratedTools: activeTools.map((t) => t.name),
        debug: {
          systemPrompt: state.systemPrompt,
          toolNames: activeTools.map((t) => t.name),
          modelResponse: result.content,
          toolCallsMade: result.toolCalls.map((tc) => ({ name: tc.toolName, args: tc.args })),
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
