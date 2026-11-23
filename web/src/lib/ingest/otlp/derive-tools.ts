import { createHash } from "node:crypto";
import type { ParsedTraceEvent } from "@/lib/ingest/trace-events/parse";
import { attrBool, attrString } from "./anyvalue";
import {
  ancestorsOf,
  firstString,
  indexSpans,
  MCP_SESSION_KEYS,
  parsedValue,
  resolveUp,
  SESSION_KEYS,
  USER_KEYS,
} from "./attr-resolve";
import { GEN_AI } from "./constants";
import {
  mcpServerOfCall,
  NO_SPAN_DIMENSIONS,
  namedAgentOf,
  type SpanDimensionsById,
} from "./dimensions";
import { promptOf } from "./prompt-text";
import { plausibleOccurredAt } from "./reconstruct";
import {
  mcpServerOf,
  skillNameOf,
  type ToolDialect,
  toolNameOf,
  toolSpanDialect,
} from "./span-facts";
import type { DecodedSpan } from "./types";

/**
 * Bridge a customer's own OTel tool-call spans into the turn ledger.
 *
 * Agent health reads only `trace_events`. Hosts on the Ratel SDK publish
 * `invoke_*` facts directly; hosts that only point an OTel exporter at us send
 * tool calls as spans, which until now never reached the ledger. Each tool span
 * becomes one `invoke_end` (or `invoke_error`) row on the `otlp` lane: an
 * unpaired end is a complete step to the segmenter, so no start row is needed.
 *
 * No content leaves here. Arguments and results are reduced to an argument hash,
 * an "empty result" bit and, for a result that reports a failure, an error type
 * naming its HTTP status and error code; the text itself is never stored.
 *
 * Idempotent: the client-event id is the span's own ids, which exporter retries
 * reuse, so a re-export collides on the deterministic trace-event id.
 */

const CALL_ID_KEYS = [GEN_AI.toolCallId, "tool.id", "ai.toolCall.id", "tool_use_id"] as const;
const ARGUMENT_KEYS = [
  GEN_AI.toolCallArguments,
  "ai.toolCall.args",
  "gcp.vertex.agent.tool_call_args",
  "tool_arguments",
  "traceloop.entity.input",
  "input.value",
] as const;
const RESULT_KEYS = [
  GEN_AI.toolCallResult,
  "ai.toolCall.result",
  "gcp.vertex.agent.tool_response",
  "tool_response",
  "traceloop.entity.output",
  "output.value",
] as const;
const MAX_ID = 256;
const MAX_ERROR_TYPE = 256;
const STATUS_ERROR = 2;
const KIND_SERVER = 2;
const KIND_CLIENT = 3;

/** Strings a tool returns when it found nothing. */
const EMPTY_TEXT =
  /^(?:|null|none|n\/a|no (?:results?|matches?|items?|records?)(?: found)?|not found)\.?$/i;
const EMPTY_LIST_KEYS = ["results", "items", "data", "content", "matches", "records"] as const;

/** Whether a captured tool result says "nothing found". */
export function isEmptyResult(value: unknown): boolean {
  const parsed = typeof value === "string" ? parsedValue(value) : value;
  if (parsed === null || parsed === undefined) return true;
  if (typeof parsed === "string") return EMPTY_TEXT.test(parsed.trim());
  if (Array.isArray(parsed)) return parsed.length === 0;
  if (typeof parsed !== "object") return false;
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0) return true;
  return EMPTY_LIST_KEYS.some((key) => {
    const list = record[key];
    return Array.isArray(list) && (list.length === 0 || list.every(isBlankContentPart));
  });
}

function isBlankContentPart(part: unknown): boolean {
  if (!part || typeof part !== "object") return false;
  const text = (part as Record<string, unknown>).text;
  return typeof text === "string" && EMPTY_TEXT.test(text.trim());
}

/** The tool call's error type, or null when it succeeded. */
export function toolErrorType(span: DecodedSpan): string | null {
  const errorType = attrString(span.attributes, "error.type")?.trim();
  const status = attrString(span.attributes, "gen_ai.tool.status")?.toLowerCase();
  const failedFlag = attrBool(span.attributes, "success") === false;
  const exception = span.events.find((e) => e.name === "exception");
  const failed =
    span.statusCode === STATUS_ERROR ||
    Boolean(errorType) ||
    (status !== undefined && status !== "success" && status !== "ok") ||
    failedFlag ||
    Boolean(exception);
  if (!failed) return null;
  const named =
    errorType ||
    attrString(span.attributes, "error_type") ||
    (exception ? attrString(exception.attributes, "exception.type") : undefined) ||
    (status && status !== "success" ? status : undefined);
  return (named ?? "error").slice(0, MAX_ERROR_TYPE);
}

/** A result cut short (an import keeps a few kilobytes) still opens like this when it failed. */
const FAILED_PREFIX = /^\s*\{\s*"(?:ok|success)"\s*:\s*false\b|^\s*\{\s*"isError"\s*:\s*true\b/;
/** The innermost error code a failed result names, as `"error":"tool_not_declared"`. */
const ERROR_CODE = /\\?"(?:error|code|reason)\\?"\s*:\s*\\?"([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\\?"/g;
const HTTP_STATUS = /\bHTTP (\d{3})\b/;
const MAX_CODE = 64;

/**
 * Why a call that ran without an error status failed anyway, from its
 * captured result: many tools report failure as data (`{"ok": false, "error":
 * …}`, `{"success": false}`, an MCP `{"isError": true}` result, a top-level
 * `error`). Null when the result does not say so, or was not captured. The
 * type reads `result`, then the HTTP status and the innermost error code the
 * text names when it has them, e.g. `result:http_403:tool_not_declared`.
 */
export function resultFailure(span: DecodedSpan): string | null {
  for (const key of RESULT_KEYS) {
    if (key in span.attributes) return resultFailureOf(span.attributes[key]);
  }
  return null;
}

export function resultFailureOf(value: unknown): string | null {
  const raw =
    typeof value === "string"
      ? value
      : value === undefined || value === null
        ? ""
        : JSON.stringify(value);
  const parsed = typeof value === "string" ? parsedValue(value) : value;
  let failed: boolean;
  let status: number | null = null;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const r = parsed as Record<string, unknown>;
    const fine = r.ok === true || r.success === true;
    const error = r.error;
    failed =
      r.ok === false ||
      r.success === false ||
      r.isError === true ||
      (typeof r.status === "string" && /^(?:error|failed|failure)$/i.test(r.status)) ||
      (!fine && error !== undefined && error !== null && error !== false && error !== "");
    for (const key of ["status", "statusCode", "status_code"]) {
      const n = r[key];
      if (typeof n === "number" && n >= 400 && n < 600) status = n;
    }
  } else {
    failed = FAILED_PREFIX.test(raw);
  }
  if (!failed) return null;
  const http = raw.match(HTTP_STATUS)?.[1] ?? (status !== null ? String(status) : null);
  const code = [...raw.matchAll(ERROR_CODE)].at(-1)?.[1];
  return ["result", http ? `http_${http}` : null, code ? code.slice(0, MAX_CODE) : null]
    .filter(Boolean)
    .join(":");
}

/** Opens a framework's plain-text answer to a tool name it does not know. Anchored: "User not found" is a tool's own answer. */
const NO_SUCH_TOOL =
  /^\s*(?:error:?\s*)?(?:(?:tool|function)\s+['"`]?[\w.:/-]+['"`]?\s+(?:not found|does not exist|is not available)|unknown (?:tool|function)\b|no such (?:tool|function)\b|['"`]?[\w.:/-]+['"`]?\s+is not a valid tool\b)/i;

/**
 * Whether a captured plain-text result says the called tool does not exist.
 * Recorded beside the call's outcome and never changing it: only the
 * `unknown_tool` guard reads it, so that such a call does not vouch for the name.
 */
function resultSaysNoSuchTool(span: DecodedSpan): boolean {
  for (const key of RESULT_KEYS) {
    if (key in span.attributes) {
      const value = span.attributes[key];
      return typeof value === "string" && NO_SUCH_TOOL.test(value);
    }
  }
  return false;
}

function argumentHash(span: DecodedSpan): string | null {
  for (const key of ARGUMENT_KEYS) {
    const raw = span.attributes[key];
    if (raw === undefined || raw === null) continue;
    const text = typeof raw === "string" ? raw : JSON.stringify(raw);
    return createHash("sha256").update(text).digest("hex").slice(0, 16);
  }
  return null;
}

function resultEmpty(span: DecodedSpan): boolean | null {
  for (const key of RESULT_KEYS) {
    if (key in span.attributes) return isEmptyResult(span.attributes[key]);
  }
  return null;
}

/** A tool span nested inside another tool span is the same call seen twice
 * (a framework span wrapping an MCP client span): only the outer one counts. */
function insideAnotherToolSpan(span: DecodedSpan, byId: ReadonlyMap<string, DecodedSpan>): boolean {
  return ancestorsOf(span, byId).some((a) => toolSpanDialect(a) !== null);
}

/** The conversation id up the span, else the MCP transport session. */
export function sessionOf(
  span: DecodedSpan,
  byId: ReadonlyMap<string, DecodedSpan>,
): string | undefined {
  return resolveUp(span, byId, SESSION_KEYS) ?? resolveUp(span, byId, MCP_SESSION_KEYS);
}

const isMcpCall = (span: DecodedSpan, kind: number): boolean =>
  span.kind === kind && toolSpanDialect(span) === "mcp";

/**
 * The span that names one tool call across processes. An MCP client
 * propagates the context of the span that sends `tools/call` (the MCP Python
 * SDK's `MCP send tools/call`), so the server's `tools/call` span is that span's
 * child, exported by another process in another request. Both sides key the
 * call by that sending span: the client by its deepest MCP client span in the
 * batch, the server by its remote parent. The row ids then collide and the
 * store keeps one, whichever side arrives first.
 */
function callSpanId(
  span: DecodedSpan,
  byId: ReadonlyMap<string, DecodedSpan>,
  childrenOf: ReadonlyMap<string, readonly DecodedSpan[]>,
): string {
  if (isMcpCall(span, KIND_SERVER) && span.parentSpanId && !byId.has(span.parentSpanId)) {
    return span.parentSpanId;
  }
  let deepest = { id: span.spanId, depth: -1 };
  const seen = new Set<string>();
  const walk = (parent: DecodedSpan, depth: number): void => {
    for (const child of childrenOf.get(parent.spanId) ?? []) {
      if (seen.has(child.spanId)) continue;
      seen.add(child.spanId);
      if (isMcpCall(child, KIND_CLIENT) && depth > deepest.depth)
        deepest = { id: child.spanId, depth };
      walk(child, depth + 1);
    }
  };
  walk(span, 0);
  return deepest.id;
}

function childrenIndex(spans: readonly DecodedSpan[]): Map<string, DecodedSpan[]> {
  const out = new Map<string, DecodedSpan[]>();
  for (const span of spans) {
    if (!span.parentSpanId) continue;
    out.set(span.parentSpanId, [...(out.get(span.parentSpanId) ?? []), span]);
  }
  return out;
}

/**
 * The user's request on a run imported from another tool (`lib/health-imports`),
 * whose root span carries it. A log of tool calls has no model call to read the
 * ask from, so the import's tool rows carry it instead. Live exports never set
 * `ratel.import.source`, so their rows are unchanged.
 */
function importedAsk(span: DecodedSpan, byId: ReadonlyMap<string, DecodedSpan>): string | null {
  const root = ancestorsOf(span, byId).find((a) => !a.parentSpanId);
  if (!root || attrString(root.attributes, "ratel.import.source") === undefined) return null;
  return promptOf(root.attributes);
}

/**
 * Every tool-call span in the export as an `invoke_end` / `invoke_error` row.
 * `dimensions` is the export's span dimensions, which ingest derives one time
 * (`lib/otlp/dimensions`): a row takes its `server` from them. They are never
 * derived here: a span they hold no MCP server for takes it from
 * `mcp.server.name` or its `mcp__server__tool` name (AOBS-5). Each row also
 * names its skill. The payload's agent does not depend on the dimensions.
 */
export function deriveToolInvocations(
  spans: readonly DecodedSpan[],
  dimensions: SpanDimensionsById = NO_SPAN_DIMENSIONS,
): ParsedTraceEvent[] {
  const byId = indexSpans(spans);
  const childrenOf = childrenIndex(spans);
  const out: ParsedTraceEvent[] = [];
  for (const span of spans) {
    const dialect = toolSpanDialect(span);
    if (!dialect || !span.spanId || !span.traceId) continue;
    if (insideAnotherToolSpan(span, byId)) continue;
    const toolId = toolNameOf(span);
    if (!toolId) continue;
    const callSpan = callSpanId(span, byId, childrenOf);
    // The MCP client span under a framework's tool span names the server.
    const server = mcpServerOfCall(dimensions.get(span.spanId), dimensions.get(callSpan));
    const row = toolRow(
      span,
      byId,
      dialect,
      toolId,
      callSpan,
      namedAgentOf(span, byId)?.name ?? null,
      server,
    );
    out.push({
      ...row,
      server: row.server ?? mcpServerOf(span, toolId),
      skillId: skillNameOf(span),
    });
  }
  return out;
}

function toolRow(
  span: DecodedSpan,
  byId: ReadonlyMap<string, DecodedSpan>,
  dialect: ToolDialect,
  toolId: string,
  callSpan: string,
  agent: string | null,
  server: string | null,
): ParsedTraceEvent {
  // A call can fail without saying so on the span: its result says it instead.
  const errorType = toolErrorType(span) ?? resultFailure(span);
  const type = errorType ? "invoke_error" : "invoke_end";
  const session = sessionOf(span, byId);
  // The trace's root is this tool call: the trace holds no other one (a
  // nested tool span is the same call). An MCP server that receives no trace
  // context exports every call this way.
  const rootTool = !span.parentSpanId;
  const callId =
    firstString(span.attributes, CALL_ID_KEYS) ??
    (dialect === "mcp" ? attrString(span.attributes, "jsonrpc.request.id") : undefined);
  const startOk = plausibleOccurredAt(span.startUnixMs);
  const tookMs = startOk ? Math.max(0, Math.round(span.endUnixMs - span.startUnixMs)) : null;
  const empty = errorType ? null : resultEmpty(span);
  const argHash = argumentHash(span);
  const ask = importedAsk(span, byId);
  return {
    ingestSource: "otlp",
    clientEventId: `otlp:tool:${span.traceId}:${callSpan}`,
    eventId: null,
    sourceId: attrString(span.resourceAttributes, "service.name")?.slice(0, MAX_ID) ?? null,
    invocationId: (callId ?? span.spanId).slice(0, MAX_ID),
    turnId: null,
    traceId: span.traceId,
    spanId: span.spanId,
    type,
    schemaVersion: 1,
    sessionId: (session ?? span.traceId).slice(0, MAX_ID),
    occurredAt: startOk ?? new Date(),
    toolId,
    skillId: null,
    query: null,
    origin: null,
    tookMs: tookMs !== null && tookMs <= 2_147_483_647 ? tookMs : null,
    errorMessage: errorType,
    topK: null,
    hitCount: null,
    // The MCP server the call reached or, on the server's own span, the server (RC-808).
    server,
    searchId: null,
    correlationId: null,
    catalogVersion: null,
    harness: null,
    environment: null,
    endUserId: resolveUp(span, byId, USER_KEYS)?.slice(0, MAX_ID) ?? null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    payload: {
      type,
      tool_id: toolId,
      derived_from: "otlp",
      dialect,
      has_session: session !== undefined,
      ...(rootTool ? { root_tool: true } : {}),
      ...(agent ? { agent } : {}),
      ...(errorType ? { error_type: errorType } : {}),
      ...(empty !== null ? { result_empty: empty } : {}),
      ...(!errorType && resultSaysNoSuchTool(span) ? { result_no_such_tool: true } : {}),
      ...(argHash ? { arg_hash: argHash } : {}),
      ...(tookMs !== null ? { took_ms: tookMs } : {}),
      ...(ask ? { prompt: ask } : {}),
    },
    hits: [],
  };
}
