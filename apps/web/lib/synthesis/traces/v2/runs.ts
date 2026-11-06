/**
 * The Runs list's rows and its key numbers (DESIGN.md, Glossary: a root trace
 * is a "Run" in lists). A run reads as what was asked when content is
 * captured, else as its root span in plain words; its tools are the ones it
 * called, in the order it first called them.
 */

import type { TraceAggregateSummary } from "@/lib/synthesis/traces/queries";
import type { TraceSummaryView } from "@/lib/synthesis/traces/view";
import { formatCompact, formatDuration, formatInteger, formatMoney, formatPercent } from "./format";
import { humanSpanName } from "./span-kind";

/** What the list knows about a run beyond its summary row. */
export interface RunDetails {
  /** Tool names in the order the run first called them. */
  tools: readonly string[];
  /** The ask, when content is captured. */
  prompt: string | null;
  /**
   * Whether the run's top-level span has arrived. Spans arrive as they end and
   * the top-level one ends last, so without it the run is still going (or its
   * end was never sent). Unknown when the read failed: then nothing is claimed.
   */
  hasRoot?: boolean;
}

/** "incomplete": no top-level span yet, so neither finished nor failed. */
export type RunStatus = "completed" | "failed" | "incomplete";

export interface RunRow {
  id: string;
  status: RunStatus;
  title: string;
  /** Whether the title is the captured ask or the span name. */
  titleIsAsk: boolean;
  startedAt: string;
  durationMs: number;
  tools: readonly string[];
  tokens: number;
  costUsd: number;
  spanCount: number;
  errorCount: number;
  experiment: string | null;
  variant: string | null;
}

/** Characters of the ask a row keeps; the cell truncates further, the tooltip shows this. */
const MAX_TITLE = 240;

export function toRunRow(summary: TraceSummaryView, details?: RunDetails): RunRow {
  const ask = details?.prompt?.replace(/\s+/g, " ").trim() || null;
  return {
    id: summary.traceId,
    status: runStatus(summary.statusCode, summary.errorCount, details?.hasRoot ?? true),
    title: ask ? clip(ask, MAX_TITLE) : humanSpanName(summary.rootName),
    titleIsAsk: ask !== null,
    startedAt: summary.startedAt,
    durationMs: summary.durationMs,
    tools: details?.tools ?? [],
    tokens: summary.totalTokens,
    costUsd: summary.costUsd,
    spanCount: summary.spanCount,
    errorCount: summary.errorCount,
    experiment: summary.experimentName,
    variant: summary.experimentArm,
  };
}

/**
 * A run failed when its root did or any of its steps did. Without its
 * top-level span it has not reported an end, so it is incomplete rather than
 * completed.
 */
export function runStatus(rootStatusCode: number, errorCount: number, hasRoot = true): RunStatus {
  if (rootStatusCode === 2 || errorCount > 0) return "failed";
  return hasRoot ? "completed" : "incomplete";
}

export const RUN_STATUS_LABEL: Readonly<Record<RunStatus, string>> = {
  completed: "Completed",
  failed: "Failed",
  incomplete: "Incomplete",
};

/** Status is a dot plus its word (DESIGN.md, Color); an unfinished run is neither good nor bad. */
export const RUN_STATUS_TONE: Readonly<Record<RunStatus, "success" | "danger" | "neutral">> = {
  completed: "success",
  failed: "danger",
  incomplete: "neutral",
};

/** What "Incomplete" means, where there is room to say it. */
export const INCOMPLETE_HINT = "Still running, or its end was never sent";

/** The first `max` tools and how many more there are. */
export function visibleTools(tools: readonly string[], max = 3): { shown: string[]; more: number } {
  return { shown: tools.slice(0, max), more: Math.max(0, tools.length - max) };
}

/** Error rates at or above this read as high. */
export const HIGH_ERROR_RATE = 0.05;

export interface RunStat {
  id: "runs" | "errorRate" | "duration" | "tokens" | "cost";
  label: string;
  value: string;
  hint?: string;
  /** A danger mark beside the value: the number itself stays in text color. */
  tone?: "danger";
}

/**
 * The Runs page's key numbers. Five, not six (DESIGN.md: a StatRow holds 2 to
 * 5): the median and p95 durations share one stat.
 */
export function runStats(aggregate: TraceAggregateSummary): RunStat[] {
  const failed = aggregate.errorCount;
  const high = aggregate.count > 0 && aggregate.errorRate >= HIGH_ERROR_RATE;
  return [
    { id: "runs", label: "Runs", value: formatCompact(aggregate.count) },
    {
      id: "errorRate",
      label: "Error rate",
      value: formatPercent(aggregate.errorRate),
      hint: failed === 0 ? "No failed runs" : `${formatInteger(failed)} failed`,
      ...(high ? { tone: "danger" as const } : {}),
    },
    {
      id: "duration",
      label: "Median duration",
      value: formatDuration(aggregate.p50DurationMs),
      ...(aggregate.p95DurationMs !== null
        ? { hint: `p95 ${formatDuration(aggregate.p95DurationMs)}` }
        : {}),
    },
    { id: "tokens", label: "Tokens", value: formatCompact(aggregate.totalTokens) },
    { id: "cost", label: "Cost", value: formatMoney(aggregate.costUsd) },
  ];
}

/** The query parameter holding the runs picked for comparison. */
export const COMPARE_PARAM = "compare";
const TRACE_ID = /^[0-9a-f]{32}$/i;

/**
 * The runs picked for comparison, from the URL (DESIGN.md, Everything is a
 * URL): at most two distinct trace ids, so a shared link or the full trace's
 * "Compare" lands with the pick already made.
 */
export function compareSelection(search: string): string[] {
  const value = new URLSearchParams(search.replace(/^\?/, "")).get(COMPARE_PARAM) ?? "";
  const ids = value
    .split(",")
    .map((id) => id.trim().toLowerCase())
    .filter((id) => TRACE_ID.test(id));
  return [...new Set(ids)].slice(0, 2);
}

/** The query string with a new pick. The open row and the page stay: picking is not filtering. */
export function withCompareSelection(search: string, ids: readonly string[]): string {
  const params = new URLSearchParams(search.replace(/^\?/, ""));
  if (ids.length > 0) params.set(COMPARE_PARAM, ids.join(","));
  else params.delete(COMPARE_PARAM);
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** Toggle one run in the pick, never past two. */
export function toggleCompare(ids: readonly string[], id: string): string[] {
  if (ids.includes(id)) return ids.filter((item) => item !== id);
  return ids.length >= 2 ? [...ids] : [...ids, id];
}

/**
 * The compare page for two picked runs. It keeps the list's query (its back
 * link restores the list and the pick) minus the open row.
 */
export function compareHref(
  tracesPath: string,
  search: string,
  ids: readonly string[],
): string | null {
  if (ids.length !== 2 || ids[0] === ids[1]) return null;
  const params = new URLSearchParams(search.replace(/^\?/, ""));
  params.delete("peek");
  params.set("a", ids[0]);
  params.set("b", ids[1]);
  return `${tracesPath}/compare?${params.toString()}`;
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}
