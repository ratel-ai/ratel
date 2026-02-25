import { generateText, stepCountIs } from "ai";
import { resolveModel } from "../lib/model.js";
import type {
  AgentResponse,
  Message,
  SetupParams,
  TestHarness,
} from "../lib/types.js";
import type { ToolCallPart } from "ai";
import { MODEL, MAX_STEPS, SYSTEM_PROMPT } from "../lib/constants.js";
import { flattenSlots } from "../lib/tool-slots.js";

export default async function setup(params: SetupParams): Promise<TestHarness> {
  const executableTools: Record<string, any> = {};
  for (const [name, t] of Object.entries(params.tools)) {
    executableTools[name] = {
      ...t,
      execute: async (args: Record<string, unknown>) => {
        const result = await params.toolExecutor({
          type: "tool-call",
          toolCallId: `call-${name}-${Date.now()}`,
          toolName: name,
          args,
        });
        return result.result;
      },
    };
  }

  return {
    sendMessage: async (
      history: Message[],
      seed: number,
      expectedTools?: string[],
    ): Promise<AgentResponse> => {
      const start = performance.now();

      // Flatten ToolSlot[] to string[] so all alternatives are available
      const flatExpected = expectedTools ? flattenSlots(expectedTools) : undefined;

      // Filter tools to only those in expectedTools (oracle = perfect hydration)
      const tools = flatExpected
        ? Object.fromEntries(
          flatExpected
            .filter((name) => name in executableTools)
            .map((name) => [name, executableTools[name]]),
        )
        : executableTools;

      const result = await generateText({
        model: resolveModel(MODEL),
        seed,
        tools,
        messages: [
          { role: "system" as const, content: SYSTEM_PROMPT },
          ...history.map((m) => ({ role: m.role, content: m.content })),
        ],
        stopWhen: stepCountIs(MAX_STEPS),
      });

      const declaredToolNames = new Set(Object.keys(tools));
      const allToolCalls: ToolCallPart[] = [];
      for (const step of result.steps) {
        for (const tc of step.toolCalls ?? []) {
          if (!declaredToolNames.has(tc.toolName)) continue;
          allToolCalls.push({
            type: "tool-call",
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            args: (tc as any).input ?? tc.args ?? {},
          } as ToolCallPart);
        }
      }

      const inputTokens = result.totalUsage?.inputTokens ?? result.usage.promptTokens;
      const outputTokens = result.totalUsage?.outputTokens ?? result.usage.completionTokens;
      const durationMs = performance.now() - start;

      const response: AgentResponse = {
        content: result.text,
        toolCalls: allToolCalls,
        usage: {
          totalTokens: inputTokens + outputTokens,
          inputTokens,
          outputTokens,
          cachedInputTokens: (result.totalUsage as any)?.inputTokenDetails?.cacheReadTokens ?? undefined,
          outputReasoningTokens: (result.totalUsage as any)?.outputTokenDetails?.reasoningTokens ?? undefined,
        },
        durationMs,
        hydratedTools: flatExpected,
        ...(process.env.DEBUG && {
          debug: {
            systemPrompt: SYSTEM_PROMPT,
            toolNames: Object.keys(tools),
            modelResponse: result.text,
            toolCallsMade: allToolCalls.map((tc) => ({
              name: tc.toolName,
              args: tc.args as Record<string, unknown>,
            })),
          },
        }),
      };

      params.onMetrics?.(response.usage);

      return response;
    },
  };
}
