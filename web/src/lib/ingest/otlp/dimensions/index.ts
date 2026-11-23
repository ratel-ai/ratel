import { ancestorsOf } from "../attr-resolve";
import type { DecodedSpan } from "../types";
import { agentKeyOf } from "./agent";
import type { DetectSource } from "./keys";
import { isMcpServerSpan, type McpRole, mcpOf, mcpSessionIdOf } from "./mcp";

/**
 * The one place OTLP ingest decides which entity a span belongs to: its agent,
 * the agent that called that agent, and its MCP server. Every row builder
 * reads the answer from here, so a new detection rule is added once, in this
 * folder (`agent.ts`, `mcp.ts`), and all the rows it feeds agree.
 *
 * Pure: it reads the spans of one export and returns a new map. Ancestors
 * exported in another batch are not visible, as in `attr-resolve.ts`.
 *
 * Ingest derives the map one time and hands it to the builders. A builder
 * never derives it: a span with no entry stores `NO_DIMENSIONS`. So when the
 * derivation fails, ingest passes `NO_SPAN_DIMENSIONS` and every row is still
 * stored, with null dimensions.
 *
 * The agent name of the turn ledger payload (`payload.agent`) is not in the
 * map: `namedAgentOf` reads it with its own frozen rules, so it does not
 * depend on the derivation.
 */

export { type AgentSource, namedAgentOf, type SpanAgent } from "./agent";
export type { DetectSource } from "./keys";
export type { McpRole } from "./mcp";

export interface SpanDimensions {
  /** The entity key of the agent the span ran under, or null when nothing names one. */
  agentKey: string | null;
  agentSource: DetectSource | null;
  /** The agent that called the span's agent: the key of the nearest ancestor under another agent. */
  callerAgentKey: string | null;
  /** The entity key of the MCP server the span provides or consumes. */
  mcpServer: string | null;
  mcpServerSource: DetectSource | null;
  /** `provided`: the span is the server's side of an MCP call. `consumed`: the client's side. */
  mcpRole: McpRole | null;
  /** The MCP transport session of the span: its own `mcp.session.id` attribute. */
  mcpSessionId: string | null;
}

/** Span id to the span's dimensions, for the spans of one export. */
export type SpanDimensionsById = ReadonlyMap<string, SpanDimensions>;

/** What a row stores for a span with no dimension. */
export const NO_DIMENSIONS: SpanDimensions = {
  agentKey: null,
  agentSource: null,
  callerAgentKey: null,
  mcpServer: null,
  mcpServerSource: null,
  mcpRole: null,
  mcpSessionId: null,
};

/** The map of an export whose dimensions could not be derived: no span has an entry. */
export const NO_SPAN_DIMENSIONS: SpanDimensionsById = new Map();

/** The dimensions of every span of the export that has a span id. */
export function deriveSpanDimensions(
  spans: readonly DecodedSpan[],
  index: ReadonlyMap<string, DecodedSpan>,
): SpanDimensionsById {
  const out = new Map<string, SpanDimensions>();
  for (const span of spans) {
    if (!span.spanId) continue;
    // An MCP server span is where another process starts: the spans at and
    // under it do not take the agent of the caller's spans above it, and the
    // server's service is no agent. So the answer is the same whether the
    // client's spans came in the same export or not.
    const lineage = [span, ...ancestorsOf(span, index)];
    const serverAt = lineage.findIndex(isMcpServerSpan);
    const agent = agentKeyOf(serverAt < 0 ? lineage : lineage.slice(0, serverAt + 1), {
      serviceIsAgent: serverAt < 0,
    });
    const mcp = mcpOf(span);
    out.set(span.spanId, {
      agentKey: agent?.key ?? null,
      agentSource: agent?.source ?? null,
      callerAgentKey: null,
      mcpServer: mcp?.server ?? null,
      mcpServerSource: mcp?.source ?? null,
      mcpRole: mcp?.role ?? null,
      mcpSessionId: mcpSessionIdOf(span),
    });
  }
  // The caller needs every span's own key first.
  for (const span of spans) {
    const own = out.get(span.spanId);
    if (!own?.agentKey) continue;
    own.callerAgentKey = callerOf(span, own.agentKey, index, out);
  }
  return out;
}

/**
 * The MCP server of a tool call, for the `server` column of its ledger row.
 * `sameCall` is a second span that is the same call (a framework tool span's
 * MCP client span): its server is used when the span itself names none.
 */
export function mcpServerOfCall(
  own: SpanDimensions | undefined,
  sameCall?: SpanDimensions,
): string | null {
  return own?.mcpServer ?? sameCall?.mcpServer ?? null;
}

function callerOf(
  span: DecodedSpan,
  agentKey: string,
  index: ReadonlyMap<string, DecodedSpan>,
  dimensions: ReadonlyMap<string, SpanDimensions>,
): string | null {
  for (const ancestor of ancestorsOf(span, index)) {
    const key = dimensions.get(ancestor.spanId)?.agentKey;
    if (key && key !== agentKey) return key;
  }
  return null;
}
