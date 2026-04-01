import Anthropic from "@anthropic-ai/sdk";
import { startAgent, type ExecutableTool } from "../../scaffolding/ts/index.js";
import type { SetupBody, SendMessageBody, SendMessageResponse } from "../../lib/protocol.js";

type AnthropicTool = Anthropic.Messages.Tool & { defer_loading?: boolean };
type ContentBlock = Anthropic.Messages.ContentBlock;
type ToolResultBlockParam = Anthropic.Messages.ToolResultBlockParam;
type MessageParam = Anthropic.Messages.MessageParam;

interface State {
  client: Anthropic;
  tools: AnthropicTool[];
  executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  config: SetupBody["config"];
  systemPrompt: string;
}

function stripAgentifiedLine(prompt: string): string {
  return prompt
    .split("\n")
    .filter((l) => !l.includes("agentified_discover"))
    .join("\n");
}

export function createCallbacks() {
  let state: State | undefined;

  return {
    setup: async (tools: ExecutableTool[], config: SetupBody["config"]) => {
      if (!config.model.startsWith("claude-")) {
        throw new Error(`claude-tool-search agent requires a Claude model, got: ${config.model}`);
      }

      const client = new Anthropic();

      const anthropicTools: AnthropicTool[] = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as Anthropic.Messages.Tool.InputSchema,
        defer_loading: true,
      }));

      const executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {};
      for (const t of tools) executors[t.name] = t.execute;

      state = {
        client,
        tools: anthropicTools,
        executors,
        config,
        systemPrompt: stripAgentifiedLine(config.systemPrompt),
      };
    },

    sendMessage: async (body: SendMessageBody): Promise<SendMessageResponse> => {
      if (!state) throw new Error("Agent not set up");
      const start = performance.now();

      const allTools: AnthropicTool[] = [
        { type: "tool_search_tool_bm25_20251119", name: "tool_search_tool_bm25" } as any,
        ...state.tools,
      ];

      let messages: MessageParam[] = body.history.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

      const allToolCalls: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }> = [];
      const hydratedTools = new Set<string>();
      let finalText = "";
      let totalInput = 0;
      let totalOutput = 0;
      let totalCached = 0;

      for (let step = 0; step < state.config.maxSteps; step++) {
        const response = await state.client.messages.create({
          model: state.config.model,
          max_tokens: 4096,
          system: state.systemPrompt,
          tools: allTools as any,
          messages,
          ...(body.seed !== undefined && { metadata: { user_id: String(body.seed) } }),
        });

        totalInput += response.usage.input_tokens;
        totalOutput += response.usage.output_tokens;
        totalCached += (response.usage as any).cache_read_input_tokens ?? 0;

        // Extract text, tool calls, and hydrated tools from response
        const toolUseBlocks: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];

        for (const block of response.content) {
          if (block.type === "text") {
            finalText = block.text;
          } else if (block.type === "tool_use") {
            toolUseBlocks.push({ id: block.id, name: block.name, input: block.input as Record<string, unknown> });
            allToolCalls.push({
              toolCallId: block.id,
              toolName: block.name,
              args: block.input as Record<string, unknown>,
            });
          } else if ((block as any).type === "tool_search_tool_result") {
            const refs = (block as any).content?.tool_references ?? [];
            for (const ref of refs) {
              if (ref.tool_name) hydratedTools.add(ref.tool_name);
            }
          }
        }

        if (response.stop_reason !== "tool_use" || toolUseBlocks.length === 0) break;

        // Execute tools and build result messages
        messages.push({ role: "assistant", content: response.content as any });

        const toolResults: ToolResultBlockParam[] = [];
        for (const tu of toolUseBlocks) {
          if (tu.name === "tool_search_tool_bm25") continue; // server-handled
          try {
            const result = await state.executors[tu.name]!(tu.input);
            toolResults.push({
              type: "tool_result",
              tool_use_id: tu.id,
              content: JSON.stringify(result),
            });
          } catch (err: any) {
            toolResults.push({
              type: "tool_result",
              tool_use_id: tu.id,
              content: `Error: ${err.message}`,
              is_error: true,
            });
          }
        }

        if (toolResults.length > 0) {
          messages.push({ role: "user", content: toolResults });
        }
      }

      // Filter out tool_search internal calls from reported toolCalls
      const externalToolCalls = allToolCalls.filter((tc) => tc.toolName !== "tool_search_tool_bm25");

      return {
        content: finalText,
        toolCalls: externalToolCalls,
        usage: {
          totalTokens: totalInput + totalOutput,
          inputTokens: totalInput,
          outputTokens: totalOutput,
          cachedInputTokens: totalCached || undefined,
        },
        durationMs: performance.now() - start,
        hydratedTools: [...hydratedTools],
        debug: {
          systemPrompt: state.systemPrompt,
          toolNames: state.tools.map((t) => t.name),
          modelResponse: finalText,
          toolCallsMade: externalToolCalls.map((tc) => ({ name: tc.toolName, args: tc.args })),
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
