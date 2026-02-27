import { generateText, stepCountIs, tool as aiTool } from "ai";
import { jsonSchemaToZod } from "@agentified/mastra";
import { startAgent, type ExecutableTool } from "../../scaffolding/ts/index.js";
import type { SetupBody, SendMessageBody, SendMessageResponse } from "../../lib/protocol.js";
import { flattenSlots } from "../../lib/tool-slots.js";

interface State {
  tools: Record<string, any>;
  config: SetupBody["config"];
}

export function createCallbacks() {
  let state: State | undefined;

  return {
    setup: async (tools: ExecutableTool[], config: SetupBody["config"]) => {
      const aiTools: Record<string, any> = {};
      for (const t of tools) {
        aiTools[t.name] = aiTool({
          description: t.description,
          parameters: jsonSchemaToZod(t.parameters),
          execute: async (args: any) => t.execute(args as Record<string, unknown>),
        } as any);
      }
      state = { tools: aiTools, config };
    },

    sendMessage: async (body: SendMessageBody): Promise<SendMessageResponse> => {
      if (!state) throw new Error("Agent not set up");
      const start = performance.now();

      const flatExpected = body.expectedTools ? flattenSlots(body.expectedTools) : undefined;

      const tools = flatExpected
        ? Object.fromEntries(
            flatExpected.filter((name) => name in state!.tools).map((name) => [name, state!.tools[name]]),
          )
        : state.tools;

      const result = await generateText({
        model: (await import("../../lib/model.js")).resolveModel(state.config.model),
        seed: body.seed,
        tools,
        messages: [
          { role: "system" as const, content: state.config.systemPrompt },
          ...body.history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
        ],
        stopWhen: stepCountIs(state.config.maxSteps),
      });

      const declaredToolNames = new Set(Object.keys(tools));
      const toolCalls = (result.steps ?? []).flatMap((step) =>
        (step.toolCalls ?? [])
          .filter((tc) => declaredToolNames.has(tc.toolName))
          .map((tc) => ({
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            args: (tc as any).input ?? (tc as any).args ?? {},
          })),
      );

      const inputTokens = result.totalUsage?.inputTokens ?? (result.usage as any).promptTokens ?? 0;
      const outputTokens = result.totalUsage?.outputTokens ?? (result.usage as any).completionTokens ?? 0;

      return {
        content: result.text,
        toolCalls,
        usage: {
          totalTokens: inputTokens + outputTokens,
          inputTokens,
          outputTokens,
          cachedInputTokens: (result.totalUsage as any)?.inputTokenDetails?.cacheReadTokens ?? undefined,
          outputReasoningTokens: (result.totalUsage as any)?.outputTokenDetails?.reasoningTokens ?? undefined,
        },
        durationMs: performance.now() - start,
        hydratedTools: flatExpected,
        debug: {
          systemPrompt: state.config.systemPrompt,
          toolNames: Object.keys(tools),
          modelResponse: result.text,
          toolCallsMade: toolCalls.map((tc) => ({ name: tc.toolName, args: tc.args })),
        },
      };
    },
  };
}

if (process.argv[1]?.endsWith("oracle.ts") || process.argv[1]?.endsWith("oracle.js")) {
  const cbs = createCallbacks();
  startAgent({ setup: cbs.setup, sendMessage: cbs.sendMessage });
}
