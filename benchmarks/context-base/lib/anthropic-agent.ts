import Anthropic from "@anthropic-ai/sdk";

type MessageParam = Anthropic.Messages.MessageParam;
type ToolResultBlockParam = Anthropic.Messages.ToolResultBlockParam;

export interface ToolCall {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface AgenticLoopResult {
  content: string;
  toolCalls: ToolCall[];
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
  hydratedTools: string[];
}

export interface AgenticLoopParams {
  client: Anthropic;
  model: string;
  system: string;
  tools: Anthropic.Messages.Tool[];
  messages: MessageParam[];
  maxSteps: number;
  executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  /** Called before each API call; return replacement tools array if needed */
  beforeStep?: (step: number) => Promise<{ tools?: Anthropic.Messages.Tool[] } | void>;
  /** Called when tool_search_tool_result blocks appear */
  onToolSearchResult?: (toolNames: string[]) => void;
  /** Filter tool calls before reporting (e.g. exclude internal tools) */
  filterReportedCalls?: (calls: ToolCall[]) => ToolCall[];
}

export async function runAgenticLoop(params: AgenticLoopParams): Promise<AgenticLoopResult> {
  const { client, model, system, executors, maxSteps, filterReportedCalls } = params;
  let { tools } = params;
  const messages: MessageParam[] = [...params.messages];

  const allToolCalls: ToolCall[] = [];
  const hydratedTools = new Set<string>();
  let finalText = "";
  let totalInput = 0;
  let totalOutput = 0;
  let totalCached = 0;

  for (let step = 0; step < maxSteps; step++) {
    if (params.beforeStep) {
      const override = await params.beforeStep(step);
      if (override?.tools) tools = override.tools;
    }

    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system,
      tools: tools as any,
      messages,
    });

    totalInput += response.usage.input_tokens;
    totalOutput += response.usage.output_tokens;
    totalCached += (response.usage as any).cache_read_input_tokens ?? 0;

    const toolUseBlocks: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];

    for (const block of response.content) {
      if (block.type === "text") {
        finalText = block.text;
      } else if (block.type === "tool_use") {
        toolUseBlocks.push({ id: block.id, name: block.name, input: block.input as Record<string, unknown> });
        allToolCalls.push({ toolCallId: block.id, toolName: block.name, args: block.input as Record<string, unknown> });
      } else if ((block as any).type === "tool_search_tool_result") {
        const refs = (block as any).content?.tool_references ?? [];
        const names = refs.map((r: any) => r.tool_name).filter(Boolean);
        for (const name of names) hydratedTools.add(name);
        params.onToolSearchResult?.(names);
      }
    }

    if (response.stop_reason !== "tool_use" || toolUseBlocks.length === 0) break;

    messages.push({ role: "assistant", content: response.content as any });

    const toolResults: ToolResultBlockParam[] = [];
    for (const tu of toolUseBlocks) {
      const executor = executors[tu.name];
      if (!executor) continue; // server-handled tool (e.g. tool_search)
      try {
        const result = await executor(tu.input);
        toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(result) });
      } catch (err: any) {
        toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: `Error: ${err.message}`, is_error: true });
      }
    }

    if (toolResults.length > 0) {
      messages.push({ role: "user", content: toolResults });
    }
  }

  const reportedCalls = filterReportedCalls ? filterReportedCalls(allToolCalls) : allToolCalls;

  return {
    content: finalText,
    toolCalls: reportedCalls,
    usage: { inputTokens: totalInput, outputTokens: totalOutput, cachedInputTokens: totalCached || undefined },
    hydratedTools: [...hydratedTools],
  };
}

export function toAnthropicTools(tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>): AnthropicTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

export function stripAgentifiedLine(prompt: string): string {
  return prompt.split("\n").filter((l) => !l.includes("agentified_discover")).join("\n");
}
