import { CONTEXT_SOURCES, type ContextSource, SOURCE_META } from "@/lib/ingest/context";
import { fmtCount } from "@/lib/platform/format";
import type { DashboardModel } from "@/lib/synthesis/dashboard";

/**
 * Overview v2 as plain data: the window, the change figures, the daily series
 * under each stat and the context split ("Needs attention" is `attention.ts`,
 * the product tiles `glance.ts`). Pure, so the page stays a thin loader and
 * every rule here is tested without a database.
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

const DAY_MS = 86_400_000;

/** Shown where a number is missing. An en dash: never an em dash in UI. */
export const NO_VALUE = "–";

/**
 * The comparison window for change figures: the same stretch of time one
 * window earlier, cut at the same point. The current window runs from
 * midnight `since` to now, so the previous one ends at `now` minus the window,
 * not at `since`; a whole previous window against a partly elapsed today
 * would read as a drop every morning.
 */
export function previousWindow(
  range: { since: Date },
  days: number,
  now: Date,
): { since: Date; until: Date } {
  const shift = days * DAY_MS;
  return { since: new Date(range.since.getTime() - shift), until: new Date(now.getTime() - shift) };
}

/* - Change figures ----------------------------------------------------------- */

export type ChangeDirection = "up" | "down" | "flat";

export interface Change {
  direction: ChangeDirection;
  /** Signed and formatted: "+12%", "-3 pts". */
  text: string;
}

/** Relative change; null without a baseline (nothing to compare against). */
export function percentChange(current: number, previous: number): Change | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return null;
  const whole = Math.round(((current - previous) / previous) * 100);
  if (whole === 0) return { direction: "flat", text: "0%" };
  return { direction: whole > 0 ? "up" : "down", text: `${whole > 0 ? "+" : ""}${whole}%` };
}

/** Change between two shares, in percentage points: "+4 pts". */
export function pointChange(current: number | null, previous: number | null): Change | null {
  if (current === null || previous === null) return null;
  return pointDelta(current - previous);
}

/** A share delta already computed elsewhere (Agent health tiles), in points. */
export function pointDelta(delta: number | null): Change | null {
  if (delta === null || !Number.isFinite(delta)) return null;
  const whole = Math.round(delta * 100);
  if (whole === 0) return { direction: "flat", text: "0 pts" };
  return { direction: whole > 0 ? "up" : "down", text: `${whole > 0 ? "+" : ""}${whole} pts` };
}

/* - Numbers ------------------------------------------------------------------ */

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

/** Daily counts in window order, zero-filled for days without runs. */
export function dailyCounts(
  volume: readonly { day: string; count: number }[],
  days: readonly string[],
): number[] {
  const byDay = new Map(volume.map(({ day, count }) => [day, count]));
  return days.map((day) => byDay.get(day) ?? 0);
}

/**
 * A daily reading in window order: the value of each day that has one, null
 * for a day without (no runs, nothing to read), so a spark draws a gap there
 * instead of a zero that never happened.
 */
export function dailyReadings<T extends { day: string }>(
  rows: readonly T[],
  days: readonly string[],
  read: (row: T) => number | null,
): (number | null)[] {
  const byDay = new Map(rows.map((row) => [row.day, row]));
  return days.map((day) => {
    const row = byDay.get(day);
    const value = row ? read(row) : null;
    return value !== null && Number.isFinite(value) ? value : null;
  });
}

/** Each day's failed share of its runs; null on a day without runs. */
export function dailyFailureShares(
  volume: readonly { day: string; count: number; errorCount: number }[],
  days: readonly string[],
): (number | null)[] {
  return dailyReadings(volume, days, (row) => (row.count > 0 ? row.errorCount / row.count : null));
}

/** Whether a series has anything to draw: at least one reading above zero. */
export function hasTrend(series: readonly (number | null)[]): boolean {
  return series.some((value) => value !== null && value > 0);
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
