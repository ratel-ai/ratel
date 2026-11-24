import { CONTEXT_SOURCES, type ContextSource, SOURCE_META } from "@/lib/ingest/context";
import { fmtCount } from "@/lib/platform/format";
import type { DashboardModel } from "@/lib/synthesis/dashboard";

/**
 * Overview as plain data: the window, its counts and the context split. Pure,
 * so the page stays a thin loader and every rule here is tested without a database.
 */

export const OVERVIEW_WINDOWS = [7, 30] as const;
export type OverviewWindow = (typeof OVERVIEW_WINDOWS)[number];
export const DEFAULT_OVERVIEW_WINDOW: OverviewWindow = 7;

/** The `?range=` value for a window, shared with Traces so links carry over. */
export function overviewRangeParam(window: OverviewWindow): `${OverviewWindow}d` {
  return `${window}d`;
}

/** Reads `?range=`; anything but `30d` is the default week. */
export function parseOverviewWindow(raw: string | readonly string[] | undefined): OverviewWindow {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === "30d" ? 30 : DEFAULT_OVERVIEW_WINDOW;
}

/** A stat-sized count: exact below 10,000, then "12.4K" and "1.2M". */
export function compactCount(value: number): string {
  const abs = Math.abs(value);
  if (abs < 10_000) return fmtCount(value);
  const thousands = trimDecimal(value / 1_000);
  // 999,500 rounds to "1000K"; past that point it reads as millions.
  if (abs < 1_000_000 && Math.abs(Number(thousands)) < 1_000) return `${thousands}K`;
  return `${trimDecimal(value / 1_000_000)}M`;
}

function trimDecimal(value: number): string {
  const fixed = Math.abs(value) >= 100 ? Math.round(value).toString() : value.toFixed(1);
  return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
}

/* - Context split ------------------------------------------------------------ */

export interface ContextRow {
  source: ContextSource;
  label: string;
  tokens: number;
  /** Of all context tokens, 0 to 1. */
  share: number;
  /** The part of this source the model never needed, when it can be measured. */
  waste: { label: string; share: number } | null;
}

export interface ContextSplit {
  totalTokens: number;
  runs: number;
  rows: ContextRow[];
}

/**
 * Where the prompt's tokens come from, largest first, with the measurable
 * waste inside each source: tool definitions never called, and history the
 * provider re-read uncached. Null without SDK context reports.
 */
export function buildContextSplit(model: DashboardModel): ContextSplit | null {
  if (!model.hasData) return null;
  const bySource = model.metrics.tokens.bySource;
  const total = CONTEXT_SOURCES.reduce((sum, source) => sum + bySource[source], 0);
  if (total <= 0) return null;
  const { breakdown } = model;
  const rows = CONTEXT_SOURCES.map<ContextRow>((source) => ({
    source,
    label: SOURCE_META[source].label,
    tokens: bySource[source],
    share: bySource[source] / total,
    waste:
      source === "tools" && breakdown.toolsUnusedRate > 0
        ? { label: "never called", share: breakdown.toolsUnusedRate }
        : source === "history" && breakdown.historyUncachedRate > 0
          ? { label: "re-read uncached", share: breakdown.historyUncachedRate }
          : null,
  }))
    .filter((row) => row.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);
  return { totalTokens: total, runs: model.runs, rows };
}
