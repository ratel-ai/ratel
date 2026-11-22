import { createHash } from "node:crypto";
import { getLogger } from "@/lib/platform/logger";
import {
  type LookupProjectLabels,
  lookupProjectLabels,
  type ProjectLabels,
} from "@/lib/platform/request-log-labels";
import { attrString } from "./anyvalue";
import { firstString, MCP_SESSION_KEYS, SESSION_KEYS } from "./attr-resolve";
import { toolSpanDialect } from "./span-facts";
import type { DecodedSpan } from "./types";

/**
 * Log lines for the "Ratel Cloud: traces ingested" Datadog dashboard
 * (infra/dashboards/traces_ingested.tf), written after an export is stored:
 *
 *   - `otlp_batch_ingested`: one per stored `/v1/traces` export, with exact
 *     totals (traces, sessions, turns, spans, model and tool calls, cost).
 *   - `trace_ingested`: one per trace in that export, at most
 *     {@link MAX_TRACE_LINES}, for the distributions (size, cost, models, MCP).
 *     A trace that arrives over several exports logs one line per export.
 *   - `otlp_logs_ingested`: one per stored `/v1/logs` export.
 *
 * A turn is one trace that carries a session (conversation) id. The session
 * goes out only as a hash scoped to the project, never the raw id. No line
 * carries content, a prompt, a tool argument or a service name.
 *
 * Every line names its project and organization by `project_path` and
 * `org_slug`, as `api_request` lines do, from the request log's cached
 * project lookup. Logging never fails or changes the export.
 */

/** Per-trace lines per export; the batch line counts the rest in `trace_lines_dropped`. */
export const MAX_TRACE_LINES = 200;
/** Distinct models and instrumentation scopes kept per trace line. */
const MAX_LIST = 10;
/** Hex characters kept of a session hash. */
const SESSION_HASH_LENGTH = 16;

const SIZE_BUCKETS: readonly [number, string][] = [
  [1, "<1 KB"],
  [10, "1-10 KB"],
  [100, "10-100 KB"],
  [1_000, "100 KB-1 MB"],
];
const COST_BUCKETS: readonly [number, string][] = [
  [0.001, "<$0.001"],
  [0.01, "$0.001-0.01"],
  [0.1, "$0.01-0.1"],
  [1, "$0.1-1"],
];

/** What a stored model call row adds to its trace's line. */
export interface IngestedCall {
  event: {
    traceId?: string | null;
    model?: string | null;
    costUsd?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
  };
}

export interface TraceLine {
  spans: number;
  model_calls: number;
  tool_calls: number;
  error_spans: number;
  /** Null when no model call of the trace has a price. */
  cost_usd: number | null;
  cost_bucket: string;
  models: string[];
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
  /** JSON size of the trace's decoded spans: the wire size is per export, not per trace. */
  size_kb: number;
  size_bucket: string;
  /** A span speaks MCP (`mcp.*` attributes). */
  mcp: boolean;
  has_session: boolean;
  session_hash?: string;
  sdk_language: string | null;
  scopes: string[];
}

export interface BatchLine {
  traces: number;
  sessions: number;
  turns: number;
  spans: number;
  model_calls: number;
  tool_calls: number;
  mcp_traces: number;
  cost_usd: number | null;
  size_kb: number;
  trace_lines_dropped: number;
}

export interface IngestLogSink {
  info(fields: Record<string, unknown>, message: string): void;
}

export interface IngestLogDeps {
  sink?: IngestLogSink;
  lookupLabels?: LookupProjectLabels;
}

const logger = getLogger("otlp/ingest-log");

/** The batch line and the per-trace lines of one stored export. Pure. */
export function traceIngestLines(
  projectId: string,
  spans: readonly DecodedSpan[],
  calls: readonly IngestedCall[],
): { batch: BatchLine; traces: TraceLine[] } {
  const spansByTrace = groupBy(spans, (span) => span.traceId);
  const callsByTrace = groupBy(calls, (call) => call.event.traceId ?? "");
  const all = [...spansByTrace].map(([traceId, traceSpans]) =>
    traceLine(projectId, traceSpans, callsByTrace.get(traceId) ?? []),
  );
  const sessions = new Set(all.flatMap((line) => (line.session_hash ? [line.session_hash] : [])));
  const priced = all.flatMap((line) => (line.cost_usd === null ? [] : [line.cost_usd]));
  const batch: BatchLine = {
    traces: all.length,
    sessions: sessions.size,
    turns: all.filter((line) => line.has_session).length,
    spans: spans.length,
    model_calls: sum(all.map((line) => line.model_calls)),
    tool_calls: sum(all.map((line) => line.tool_calls)),
    mcp_traces: all.filter((line) => line.mcp).length,
    cost_usd: priced.length > 0 ? round(sum(priced), 6) : null,
    size_kb: round(sum(all.map((line) => line.size_kb)), 3),
    trace_lines_dropped: Math.max(0, all.length - MAX_TRACE_LINES),
  };
  return { batch, traces: all.slice(0, MAX_TRACE_LINES) };
}

/** Log the lines of one stored `/v1/traces` export. Never throws. */
export async function logTracesIngested(
  projectId: string,
  spans: readonly DecodedSpan[],
  calls: readonly IngestedCall[],
  deps: IngestLogDeps = {},
): Promise<void> {
  try {
    const { batch, traces } = traceIngestLines(projectId, spans, calls);
    const context = await projectFields(projectId, deps);
    const sink = deps.sink ?? logger;
    sink.info({ ...context, ...batch }, "otlp_batch_ingested");
    for (const line of traces) sink.info({ ...context, ...line }, "trace_ingested");
  } catch {
    // A logging failure is not the export's failure.
  }
}

/** Log one stored `/v1/logs` export. Never throws. */
export async function logLogsIngested(
  projectId: string,
  counts: { records: number; accepted: number; dropped: number },
  deps: IngestLogDeps = {},
): Promise<void> {
  try {
    const context = await projectFields(projectId, deps);
    (deps.sink ?? logger).info({ ...context, ...counts }, "otlp_logs_ingested");
  } catch {
    // A logging failure is not the export's failure.
  }
}

async function projectFields(
  projectId: string,
  deps: IngestLogDeps,
): Promise<Record<string, string>> {
  let labels: ProjectLabels | null = null;
  try {
    labels = await (deps.lookupLabels ?? lookupProjectLabels)(projectId);
  } catch {
    // The line goes out with the project id only.
  }
  return {
    project_id: projectId,
    ...(labels
      ? { org_id: labels.org_id, org_slug: labels.org_slug, project_path: labels.project_path }
      : {}),
  };
}

function traceLine(
  projectId: string,
  spans: readonly DecodedSpan[],
  calls: readonly IngestedCall[],
): TraceLine {
  const prices = calls.flatMap((call) => {
    const cost = call.event.costUsd == null ? NaN : Number(call.event.costUsd);
    return Number.isFinite(cost) ? [cost] : [];
  });
  const cost = prices.length > 0 ? round(sum(prices), 6) : null;
  const sizeKb = round(sum(spans.map((span) => Buffer.byteLength(JSON.stringify(span)))) / 1000, 3);
  const session = sessionOf(spans);
  return {
    spans: spans.length,
    model_calls: calls.length,
    tool_calls: spans.filter((span) => toolSpanDialect(span) !== null).length,
    error_spans: spans.filter((span) => span.statusCode === 2).length,
    cost_usd: cost,
    cost_bucket: cost === null ? "unpriced" : bucket(cost, COST_BUCKETS, ">=$1"),
    models: distinct(calls.map((call) => call.event.model)),
    input_tokens: sum(calls.map((call) => call.event.inputTokens ?? 0)),
    output_tokens: sum(calls.map((call) => call.event.outputTokens ?? 0)),
    duration_ms: Math.max(
      0,
      Math.max(...spans.map((s) => s.endUnixMs)) - Math.min(...spans.map((s) => s.startUnixMs)),
    ),
    size_kb: sizeKb,
    size_bucket: bucket(sizeKb, SIZE_BUCKETS, ">=1 MB"),
    mcp: spans.some((span) => Object.keys(span.attributes).some((key) => key.startsWith("mcp."))),
    has_session: session !== undefined,
    ...(session !== undefined ? { session_hash: sessionHash(projectId, session) } : {}),
    sdk_language:
      spans
        .map((span) => attrString(span.resourceAttributes, "telemetry.sdk.language"))
        .find(Boolean) ?? null,
    scopes: distinct(spans.map((span) => span.scopeName)),
  };
}

/** The conversation id of any span, else the MCP transport session. */
function sessionOf(spans: readonly DecodedSpan[]): string | undefined {
  for (const keys of [SESSION_KEYS, MCP_SESSION_KEYS]) {
    for (const span of spans) {
      const value =
        firstString(span.attributes, keys) ?? firstString(span.resourceAttributes, keys);
      if (value) return value;
    }
  }
  return undefined;
}

function sessionHash(projectId: string, session: string): string {
  return createHash("sha256")
    .update(`${projectId}\u0000${session}`)
    .digest("hex")
    .slice(0, SESSION_HASH_LENGTH);
}

function bucket(value: number, buckets: readonly [number, string][], top: string): string {
  return buckets.find(([below]) => value < below)?.[1] ?? top;
}

function distinct(values: readonly (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => !!value))].sort().slice(0, MAX_LIST);
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(key(item));
    if (group) group.push(item);
    else groups.set(key(item), [item]);
  }
  return groups;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function round(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}
