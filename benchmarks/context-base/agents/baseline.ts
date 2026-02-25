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

export default async function setup(params: SetupParams): Promise<TestHarness> {
  // Wrap tools with execute functions that call the toolExecutor
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
    ): Promise<AgentResponse> => {
      const start = performance.now();

      let stepCount = 0;
      const stepsUsage: any[] = [];
      const result = await generateText({
        model: resolveModel(MODEL),
        seed,
        tools: executableTools,
        messages: [
          { role: "system" as const, content: SYSTEM_PROMPT },
          ...history.map((m) => ({ role: m.role, content: m.content })),
        ],
        stopWhen: stepCountIs(MAX_STEPS),
        onStepFinish: ({ text, reasoning, toolCalls, usage }) => {
          stepsUsage[stepCount++] = {
            text,
            reasoning,
            toolCalls,
            usage: {
              input: usage.inputTokens,
              cachedInput: usage.inputTokenDetails.cacheReadTokens,
              output: usage.outputTokens,
              reasoning: usage.outputTokenDetails.reasoningTokens,
            }
          };
        },
      });

      // Collect tool calls from all steps
      const allToolCalls: ToolCallPart[] = [];
      for (const step of result.steps) {
        for (const tc of step.toolCalls ?? []) {
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

      debug(stepCount, "steps detected, token usage: ", JSON.stringify(stepsUsage, null, 2));

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
      };


      params.onMetrics?.(response.usage);

      return response;
    },
  };
}

function debug(...args: any[]) {
  process.env.DEBUG && console.debug(...args);
}
