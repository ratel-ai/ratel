import { attrString } from "../anyvalue";
import { firstString, MCP_SESSION_KEYS } from "../attr-resolve";
import { toolNameOf, toolSpanDialect } from "../span-facts";
import type { DecodedSpan } from "../types";
import { type DetectSource, entityKey } from "./keys";

/**
 * Which MCP server a span belongs to, and on which side of the call.
 *
 * A server span (`provided`) is an MCP request span of kind SERVER: the
 * process that exported it is the server, so its `service.name` is the key.
 * A client span (`consumed`) is a call to a server from the agent's side: an
 * MCP request span of kind CLIENT, a Ratel SDK invoke that proxies an upstream
 * server, or a tool call whose name carries the server (`github__create_issue`).
 */

export type McpRole = "provided" | "consumed";

export interface SpanMcp {
  server: string | null;
  source: DetectSource | null;
  role: McpRole;
}

const KIND_SERVER = 2;
const KIND_CLIENT = 3;
export const MCP_METHOD_KEY = "mcp.method.name";
/** MCP request span names when the method attribute is missing: `tools/call <tool>`, and the MCP Python SDK's `MCP send tools/call <tool>`. */
const MCP_SPAN_NAME = /^(?:MCP send )?tools\/call(?: |$)/;
/** The server's own name (`serverInfo.name` of the MCP handshake), as instrumentations spell it. */
export const SERVER_INFO_KEYS = ["mcp.server.name", "fastmcp.server.name"] as const;
export const UPSTREAM_SERVER_KEY = "ratel.upstream.server";
/** Claude-style names put a literal `mcp` first: `mcp__github__create_issue`. */
const TOOL_PREFIX = /^(?:mcp__)?([^_](?:[^_]|_(?!_))*)__./;

/** The span's MCP server and role, or null when the span is no MCP call. */
export function mcpOf(span: DecodedSpan): SpanMcp | null {
  if (isMcpServerSpan(span)) {
    const service = entityKey(attrString(span.resourceAttributes, "service.name"));
    if (service) return { server: service, source: "semconv", role: "provided" };
    const named = entityKey(firstString(span.attributes, SERVER_INFO_KEYS));
    return { server: named, source: named ? "semconv" : null, role: "provided" };
  }
  const upstream = entityKey(attrString(span.attributes, UPSTREAM_SERVER_KEY));
  if (upstream) return { server: upstream, source: "sdk", role: "consumed" };
  const isClient = span.kind === KIND_CLIENT && isMcpRequest(span);
  if (!isClient && toolSpanDialect(span) === null) return null;
  const prefixed = entityKey(toolNameOf(span)?.match(TOOL_PREFIX)?.[1]);
  if (prefixed) return { server: prefixed, source: "heuristic", role: "consumed" };
  return isClient ? { server: null, source: null, role: "consumed" } : null;
}

const MAX_SESSION_ID = 256;

/** The MCP transport session the span itself names (`mcp.session.id`), or null. */
export function mcpSessionIdOf(span: DecodedSpan): string | null {
  return firstString(span.attributes, MCP_SESSION_KEYS)?.slice(0, MAX_SESSION_ID) ?? null;
}

/** An MCP request span of kind SERVER: the exporting process is the MCP server. */
export function isMcpServerSpan(span: DecodedSpan): boolean {
  return span.kind === KIND_SERVER && isMcpRequest(span);
}

function isMcpRequest(span: DecodedSpan): boolean {
  return attrString(span.attributes, MCP_METHOD_KEY) !== undefined || MCP_SPAN_NAME.test(span.name);
}
