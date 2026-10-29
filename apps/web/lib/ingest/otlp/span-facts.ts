import { attrString } from "./anyvalue";
import { parsedValue } from "./attr-resolve";
import { EXECUTE_TOOL, GEN_AI, NON_ROUND_TRIP_OPERATIONS } from "./constants";
import { isAnchor } from "./group";
import type { DecodedSpan } from "./types";

/**
 * What one span is, read across OTel dialects: a tool call, a model round trip,
 * or neither. `group.ts` keeps its narrower `gen_ai`-only reading for the LLM
 * call reconstruction; this wider one feeds Agent health, which must see a tool
 * call however the customer's instrumentation spells it.
 */

export type ToolDialect = "genai" | "mcp" | "vercel" | "openinference" | "traceloop" | "langsmith";

const MCP_TOOLS_CALL = "tools/call";
/** Span names that end in the tool's name. `MCP send tools/call <tool>` is the
 * official MCP Python SDK's client span, which carries no tool attribute. */
const NAME_PREFIXES = [
  `${EXECUTE_TOOL} `,
  `${MCP_TOOLS_CALL} `,
  `MCP send ${MCP_TOOLS_CALL} `,
] as const;

function lower(span: DecodedSpan, key: string): string | undefined {
  return attrString(span.attributes, key)?.toLowerCase();
}

/** The dialect a tool-call span is written in, or null when it is not a tool call. */
export function toolSpanDialect(span: DecodedSpan): ToolDialect | null {
  if (attrString(span.attributes, "mcp.method.name") === MCP_TOOLS_CALL) return "mcp";
  if (span.name === "ai.toolCall" || attrString(span.attributes, "ai.toolCall.name")) {
    return "vercel";
  }
  if (attrString(span.attributes, GEN_AI.operationName) === EXECUTE_TOOL) return "genai";
  if (lower(span, "openinference.span.kind") === "tool") return "openinference";
  if (lower(span, "traceloop.span.kind") === "tool") return "traceloop";
  if (lower(span, "langsmith.span.kind") === "tool") return "langsmith";
  if (span.name.startsWith(NAME_PREFIXES[0])) return "genai";
  return null;
}

const TOOL_NAME_KEYS = [
  GEN_AI.toolName,
  "tool.name",
  "ai.toolCall.name",
  "traceloop.entity.name",
] as const;

const MAX_TOOL_NAME = 256;

/** The called tool's name: the attribute first, else the span-name suffix. */
export function toolNameOf(span: DecodedSpan): string | null {
  for (const key of TOOL_NAME_KEYS) {
    const value = attrString(span.attributes, key)?.trim();
    if (value) return value.slice(0, MAX_TOOL_NAME);
  }
  for (const prefix of NAME_PREFIXES) {
    if (span.name.startsWith(prefix)) {
      const suffix = span.name.slice(prefix.length).trim();
      if (suffix) return suffix.slice(0, MAX_TOOL_NAME);
    }
  }
  return null;
}

/** A model round trip (one chat / completion call), in any dialect. */
export function isModelRoundTrip(span: DecodedSpan): boolean {
  if (toolSpanDialect(span)) return false;
  const op = attrString(span.attributes, GEN_AI.operationName);
  if (op && NON_ROUND_TRIP_OPERATIONS.has(op)) return false;
  if (isAnchor(span)) return true;
  return (
    lower(span, "openinference.span.kind") === "llm" || lower(span, "langsmith.span.kind") === "llm"
  );
}

const MAX_MENU = 256;
const MAX_MENU_NAME = 128;

function definitionName(entry: unknown): string | undefined {
  // Mastra lists the agent's tools by name only.
  if (typeof entry === "string" && /^[\w.:/-]+$/.test(entry.trim()))
    return entry.trim().slice(0, MAX_MENU_NAME);
  const parsed = parsedValue(entry as never);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const fn = record.function as Record<string, unknown> | undefined;
  const name = record.name ?? fn?.name;
  return typeof name === "string" && name.trim() ? name.trim().slice(0, MAX_MENU_NAME) : undefined;
}

function definitionList(span: DecodedSpan): unknown[] {
  for (const key of [GEN_AI.toolDefinitions, "ai.prompt.tools"]) {
    const parsed = parsedValue(span.attributes[key]);
    if (Array.isArray(parsed)) return parsed;
  }
  const indexed: unknown[] = [];
  for (const [key, value] of Object.entries(span.attributes)) {
    if (/^llm\.tools\.\d+\.tool\.json_schema$/.test(key)) indexed.push(value);
  }
  return indexed;
}

/**
 * The names of the tools offered to the model on this round trip, sorted and
 * deduped, or null when the menu was not captured (it is opt-in content).
 * Names only: descriptions and schemas are never kept.
 */
export function toolMenuOf(span: DecodedSpan): string[] | null {
  const names = new Set<string>();
  for (const entry of definitionList(span)) {
    const name = definitionName(entry);
    if (name) names.add(name);
    if (names.size >= MAX_MENU) break;
  }
  return names.size > 0 ? [...names].sort() : null;
}
