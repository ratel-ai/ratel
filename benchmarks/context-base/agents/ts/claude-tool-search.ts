import Anthropic from "@anthropic-ai/sdk";
import { runAgenticLoop, toAnthropicTools, stripAgentifiedLine } from "../../lib/anthropic-agent.js";
import { startAgent, type ExecutableTool } from "../../scaffolding/ts/index.js";
import type { SetupBody, SendMessageBody, SendMessageResponse } from "../../lib/protocol.js";

interface State {
  client: Anthropic;
  tools: Anthropic.Messages.Tool[];
  executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  config: SetupBody["config"];
  systemPrompt: string;
}

export function createCallbacks() {
  let state: State | undefined;

  return {
    setup: async (tools: ExecutableTool[], config: SetupBody["config"]) => {
      if (!config.model.startsWith("claude-")) {
        throw new Error(`claude-tool-search agent requires a Claude model, got: ${config.model}`);
      }

      const client = new Anthropic();
      const executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {};
      for (const t of tools) executors[t.name] = t.execute;

      const deferredTools: Anthropic.Messages.Tool[] = toAnthropicTools(tools).map((t) => ({
        ...t,
        defer_loading: true,
      })) as any;

      state = {
        client,
        tools: [
          { type: "tool_search_tool_bm25_20251119", name: "tool_search_tool_bm25" } as any,
          ...deferredTools,
        ],
        executors,
        config,
        systemPrompt: stripAgentifiedLine(config.systemPrompt),
      };
    },

    sendMessage: async (body: SendMessageBody): Promise<SendMessageResponse> => {
      if (!state) throw new Error("Agent not set up");
      const start = performance.now();

      const result = await runAgenticLoop({
        client: state.client,
        model: state.config.model,
        system: state.systemPrompt,
        tools: state.tools,
        messages: body.history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
        maxSteps: state.config.maxSteps,
        executors: state.executors,
        filterReportedCalls: (calls) => calls.filter((tc) => tc.toolName !== "tool_search_tool_bm25"),
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
        hydratedTools: result.hydratedTools,
        debug: {
          systemPrompt: state.systemPrompt,
          toolNames: state.tools.filter((t: any) => t.name !== "tool_search_tool_bm25").map((t: any) => t.name),
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
