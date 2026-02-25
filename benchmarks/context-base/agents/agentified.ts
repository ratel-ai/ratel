import { generateText, stepCountIs, tool } from "ai";
import { resolveModel } from "../lib/model.js";
import { Agentified } from "@agentified/sdk";
import { z } from "zod";
import type {
  AgentResponse,
  Message,
  SetupParams,
  TestHarness,
} from "../lib/types.js";
import type { ToolCallPart } from "ai";
import { MODEL, MAX_STEPS, SYSTEM_PROMPT } from "../lib/constants.js";

const ENDPOINT = process.env.AGENTIFIED_ENDPOINT ?? "http://localhost:9119";
// Force-discovery mode: set to 0 to make agent always use discover_tools
const TOOL_LIMIT = process.env.FORCE_DISCOVERY === "1" ? 0 : 5;
const DISCOVER_TOOL_LIMIT = 10;

export default async function setup(
  params: SetupParams,
): Promise<TestHarness> {
  const sdk = new Agentified({ serverUrl: ENDPOINT, tools: [] });

  // Wrap all registry tools with execute functions
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

  // Discovery tool — fallback when prefill is insufficient
  const discoverTool = tool({
    description:
      "Search for tools by action. Only call this when you need a tool not already available to you. Send exactly ONE query per distinct tool you need — no more. Each query must be a short, specific action phrase (e.g. 'search user by name', 'update user details', 'schedule event'). Do not send duplicate or overlapping queries.",
    inputSchema: z.object({
      queries: z
        .array(
          z.string()
        )
        .max(3)
        .describe("One short action phrase per tool needed (e.g. ['search user by name', 'get record details']). Max one query per distinct action, and max 3 queries in total."),

    }),
    execute: async ({ queries }) => {
      const results = await Promise.all(queries.map(async query => {
        const res = await fetch(`${ENDPOINT}/api/v1/discover`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query,
            limit: DISCOVER_TOOL_LIMIT,
          }),
        });
        if (!res.ok) {
          debug("[FAILED discover_tool] with query '", query, "', result:", res);
          return { tools: [] };
        }
        const data = (await res.json()) as {
          tools: Array<{ name: string; description?: string }>;
        };
        debug("[SUCCESSFUL discover_tool] with query '", query, "', data:", data);
        return data.tools.map((t) => ({
          name: t.name,
          description: t.description,
        }));
      }));
      return {
        tools: results.flat(),
      }
    },
  });

  const allTools = { discover_tools: discoverTool, ...executableTools };
  const registryToolNames = new Set(Object.keys(executableTools));

  return {
    sendMessage: async (
      history: Message[],
      seed: number,
      _expectedTools?: string[],
      turnId?: string,
    ): Promise<AgentResponse> => {
      const start = performance.now();

      const lastMessage = history[history.length - 1];

      // Try prefetch (with turnId for session continuity)
      let prefilledToolNames: string[] | undefined;
      let prefillSucceeded = false;
      try {
        const tools = await sdk.prefetch({
          messages: history.map((m) => ({ role: m.role, content: m.content })),
          limit: TOOL_LIMIT,
          ...(turnId && { turnId }),
        });
        prefilledToolNames = tools.map((t) => t.name);
        prefillSucceeded = true;
        debug("[SUCCESSFUL prefetch] tools: ", prefilledToolNames);
      } catch (error) {
        // Fallback to pure agentic behavior
        debug("[FAILED prefetch] error: ", error);
      }

      const systemPrompt = SYSTEM_PROMPT;

      // Cumulative active tool set — persists discovered tools across steps
      const activeToolSet = new Set<string>(
        prefillSucceeded && prefilledToolNames ? prefilledToolNames : [],
      );
      activeToolSet.add("discover_tools");

      let stepCount = 0;
      const stepsUsage: any[] = [];
      const result = await generateText({
        model: resolveModel(MODEL),
        seed,
        tools: allTools,
        messages: [
          { role: "system" as const, content: systemPrompt },
          ...history.map((m) => ({ role: m.role, content: m.content })),
        ],
        stopWhen: stepCountIs(MAX_STEPS),
        experimental_telemetry: {
          isEnabled: true,
        },
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
        prepareStep: ({ stepNumber, steps }) => {
          // Merge all discover_tools results from prior steps into the set
          for (const step of steps) {
            const discoverResult = (step.toolResults as any[])?.find(
              (r: any) => r.toolName === "discover_tools",
            );
            if (discoverResult?.output?.tools) {
              for (const t of discoverResult.output.tools) {
                if (registryToolNames.has(t.name)) {
                  activeToolSet.add(t.name);
                }
              }
            }
          }

          const activeTools = [...activeToolSet];

          if (prefillSucceeded) {
            return { activeTools };
          }

          // Fallback: prefetch failed — pure agentic
          if (stepNumber === 0) {
            return {
              toolChoice: {
                type: "tool" as const,
                toolName: "discover_tools",
              },
            };
          }

          return { activeTools };
        },
      });

      // Collect tool calls (excluding discover_tools)
      const allToolCalls: ToolCallPart[] = [];
      for (const step of result.steps) {
        for (const tc of step.toolCalls ?? []) {
          if (tc.toolName === "discover_tools") continue;
          allToolCalls.push({
            type: "tool-call",
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            args: (tc as any).input ?? tc.args ?? {},
          } as ToolCallPart);
        }
      }

      // Build hydratedTools: start from prefill, union with discovered
      let hydratedTools: string[] | undefined = prefilledToolNames
        ? [...prefilledToolNames]
        : undefined;

      for (const step of result.steps) {
        const discoverResult = (step.toolResults as any[])?.find(
          (r: any) => r.toolName === "discover_tools",
        );
        if (discoverResult?.output?.tools) {
          const discoveredNames: string[] = discoverResult.output.tools.map(
            (t: any) => t.name,
          );
          if (hydratedTools) {
            const union = new Set([...hydratedTools, ...discoveredNames]);
            hydratedTools = [...union];
          } else {
            hydratedTools = discoveredNames;
          }
          break;
        }
      }

      // Log chain discovery: multiple discover_tools calls indicate prerequisite chaining
      const discoverCallCount = result.steps.filter((s) =>
        s.toolCalls?.some((tc) => tc.toolName === "discover_tools"),
      ).length;
      if (discoverCallCount > 1) {
        debug(`[CHAIN DISCOVERY] ${discoverCallCount} discover_tools calls — agent chained prerequisite lookups`);
      }

      // Capture turn for session continuity
      let newTurnId: string | undefined;
      try {
        const toolsLoaded = [...activeToolSet].filter((t) => t !== "discover_tools");
        const captureRes = await sdk.captureTurn({
          toolsLoaded,
          message: lastMessage.content,
        });
        newTurnId = captureRes.turnId;
        debug("[SUCCESSFUL captureTurn] turnId:", newTurnId);
      } catch (error) {
        debug("[FAILED captureTurn] error:", error);
      }

      const inputTokens =
        result.totalUsage?.inputTokens ?? result.usage.promptTokens;
      const outputTokens =
        result.totalUsage?.outputTokens ?? result.usage.completionTokens;

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
        hydratedTools,
        turnId: newTurnId,
        ...(process.env.DEBUG && {
          debug: {
            systemPrompt,
            toolNames: [...activeToolSet],
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

function debug(...args: any[]) {
  process.env.DEBUG && console.debug(...args);
}
