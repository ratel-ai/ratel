import type { AttrMap, DecodedSpan } from "./types";

/**
 * Test traces for the agent-span dedupe (flag `cloud-otlp-agent-span-dedupe`):
 * an agent wrapper span that carries the run's model and SUMMED usage, with
 * the real model calls as its children. Ids are valid OTLP hex so the same
 * traces feed `groupSpans`, `toOtelSpanRows` and `persistDecodedSpans`.
 */

export const LANGGRAPH_TRACE = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
export const CLAUDE_SDK_TRACE = "c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1";
export const AGENT_ONLY_TRACE = "e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1";

/** LangGraph custom emitter: `invoke_agent` root (summed usage) + 2 `chat` + 2 `execute_tool`, all on the root. */
export function langGraphTrace(): DecodedSpan[] {
  const root = "1000000000000001";
  return [
    span(LANGGRAPH_TRACE, root, null, "invoke_agent agent", {
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.request.model": "gpt-5.5",
      ...usage(300, 50, 100),
    }),
    span(LANGGRAPH_TRACE, "1000000000000002", root, "chat gpt-5.5", chat("gpt-5.5", 100, 20, 40)),
    span(LANGGRAPH_TRACE, "1000000000000003", root, "chat gpt-5.5", chat("gpt-5.5", 200, 30, 60)),
    span(LANGGRAPH_TRACE, "1000000000000004", root, "execute_tool search", tool("search")),
    span(LANGGRAPH_TRACE, "1000000000000005", root, "execute_tool fetch", tool("fetch")),
  ];
}

/** Claude Agent SDK: `invoke_agent` root (anthropic, summed usage) + 2 `chat`, a tool under the second chat. */
export function claudeAgentSdkTrace(): DecodedSpan[] {
  const root = "2000000000000001";
  const secondChat = "2000000000000003";
  const model = "claude-sonnet-4-5";
  return [
    span(CLAUDE_SDK_TRACE, root, null, "invoke_agent claude", {
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.provider.name": "anthropic",
      "gen_ai.request.model": model,
      ...usage(1_000, 200, 500),
    }),
    span(
      CLAUDE_SDK_TRACE,
      "2000000000000002",
      root,
      `chat ${model}`,
      chat(model, 400, 80, 200, "anthropic"),
    ),
    span(
      CLAUDE_SDK_TRACE,
      secondChat,
      root,
      `chat ${model}`,
      chat(model, 600, 120, 300, "anthropic"),
    ),
    span(CLAUDE_SDK_TRACE, "2000000000000004", secondChat, "execute_tool Read", tool("Read")),
  ];
}

/** An agent-span-only emitter: `invoke_agent` with usage, only tool children, no model-call span. */
export function agentOnlyTrace(): DecodedSpan[] {
  const root = "3000000000000001";
  return [
    span(AGENT_ONLY_TRACE, root, null, "invoke_agent solo", {
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.request.model": "gpt-5.5",
      ...usage(300, 50, 100),
    }),
    span(AGENT_ONLY_TRACE, "3000000000000002", root, "execute_tool search", tool("search")),
  ];
}

function span(
  traceId: string,
  spanId: string,
  parentSpanId: string | null,
  name: string,
  attributes: AttrMap,
): DecodedSpan {
  return {
    traceId,
    spanId,
    parentSpanId,
    name,
    kind: 3,
    startUnixMs: 1_750_000_000_000,
    endUnixMs: 1_750_000_001_000,
    attributes,
    events: [],
    statusCode: 0,
    resourceAttributes: { "service.name": "agent" },
    scopeName: "agent",
  };
}

function chat(
  model: string,
  input: number,
  output: number,
  cacheRead: number,
  provider = "openai",
): AttrMap {
  return {
    "gen_ai.operation.name": "chat",
    "gen_ai.provider.name": provider,
    "gen_ai.request.model": model,
    ...usage(input, output, cacheRead),
  };
}

function tool(name: string): AttrMap {
  return { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": name };
}

function usage(input: number, output: number, cacheRead: number): AttrMap {
  return {
    "gen_ai.usage.input_tokens": input,
    "gen_ai.usage.output_tokens": output,
    "gen_ai.usage.cache_read.input_tokens": cacheRead,
  };
}
