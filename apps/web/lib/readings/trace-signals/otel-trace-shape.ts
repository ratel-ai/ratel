/**
 * Setup warning: OpenTelemetry tool calls that arrive one per trace.
 *
 * An MCP server that receives no trace context from its client (the common
 * case: most MCP clients propagate none) starts a fresh trace for every
 * `tools/call`. OTLP ingest marks such a call `root_tool` (the tool span is
 * its trace's root, so the trace holds nothing else). A run is a trace on the
 * OTLP lane, so without help each of those runs has one tool and no workflow
 * can ever form. With a session (`gen_ai.conversation.id`, `session.id`, or
 * the MCP `mcp.session.id`), the turn builder groups a session's consecutive
 * root-tool calls by quiet gap instead (`turns/segment.ts`, rule 4), which is
 * approximate: back-to-back requests on one connection merge into one run.
 *
 * Pure. The counts are three filters over the window's OTLP tool rows
 * (`invoke_end` / `invoke_error`, `ingest_source = 'otlp'`):
 * all of them, those with `payload ->> 'root_tool' = 'true'`, and of those the
 * ones with `payload ->> 'has_session' = 'true'`.
 */

export interface RootToolCounts {
  /** OTLP tool rows in the window. */
  toolRows: number;
  /** Of those, tool calls that were the root span of their own trace. */
  rootToolRows: number;
  /** Of the root-tool rows, the ones that carried a session id. */
  rootToolRowsWithSession: number;
}

export type OneToolPerTraceVerdict =
  /** Too few tool rows to say. */
  | "not_enough_data"
  /** Most calls share a trace with the rest of their run: nothing to warn about. */
  | "ok"
  /** One call per trace, grouped into runs by session and quiet gap: approximate runs. */
  | "grouped_by_session"
  /** One call per trace and no session: every call is its own run. */
  | "ungroupable";

export interface OneToolPerTraceReading {
  verdict: OneToolPerTraceVerdict;
  /** Share of tool rows that were their trace's only call, 0..1. */
  share: number;
  /** Share of those that carried a session, 0..1. */
  sessionShare: number;
}

export interface OneToolPerTraceOptions {
  /** Fewer tool rows than this read as `not_enough_data`. */
  minToolRows?: number;
  /** At or above this share of root-tool rows the warning fires. */
  minShare?: number;
  /** At or above this share of root-tool rows with a session, runs are grouped. */
  minSessionShare?: number;
}

export const ONE_TOOL_PER_TRACE_MIN_ROWS = 20;
export const ONE_TOOL_PER_TRACE_MIN_SHARE = 0.5;
export const ONE_TOOL_PER_TRACE_MIN_SESSION_SHARE = 0.9;

const ratio = (part: number, whole: number): number =>
  whole > 0 ? Math.min(1, Math.max(0, part / whole)) : 0;

export function oneToolPerTrace(
  counts: RootToolCounts,
  options: OneToolPerTraceOptions = {},
): OneToolPerTraceReading {
  const minRows = options.minToolRows ?? ONE_TOOL_PER_TRACE_MIN_ROWS;
  const minShare = options.minShare ?? ONE_TOOL_PER_TRACE_MIN_SHARE;
  const minSessionShare = options.minSessionShare ?? ONE_TOOL_PER_TRACE_MIN_SESSION_SHARE;
  const share = ratio(counts.rootToolRows, counts.toolRows);
  const sessionShare = ratio(counts.rootToolRowsWithSession, counts.rootToolRows);
  if (counts.toolRows < minRows) return { verdict: "not_enough_data", share, sessionShare };
  if (share < minShare) return { verdict: "ok", share, sessionShare };
  return {
    verdict: sessionShare >= minSessionShare ? "grouped_by_session" : "ungroupable",
    share,
    sessionShare,
  };
}
