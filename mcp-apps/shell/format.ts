/**
 * Cell formats for the generic views, as text. They reuse the console's own
 * formatters so a number reads the same in a view as on its page: the Traces
 * page's (lib/traces/v2/format.ts: exact in tables, abbreviated in stats,
 * money with two decimals, times in UTC), the task pages'
 * (lib/tasks/format.ts) and the intent pages' whole percent. cells.tsx renders
 * the formats that are marks (badge, entity, bar) on top of these.
 */

import {
  formatCompact,
  formatDay,
  formatDuration,
  formatInteger,
  formatMoney,
  formatPercent,
  formatRelativeTime,
  formatTimestamp,
  MISSING,
  shortId,
} from "@/lib/synthesis/traces/v2/format";
import {
  formatPer100,
  formatShare,
  formatMoney as formatTaskMoney,
  NBSP,
} from "@/lib/views/tasks/format";
import type { CellFormat } from "./config";

export { MISSING };

/** Where a value is shown: a table cell is exact, a stat is abbreviated, a detail time is absolute. */
export type FormatContext = "table" | "stat" | "detail";

/** A cost the tool says has no price (null) is "Unpriced", never $0 (RC-482); an absent one is "–". */
export const UNPRICED = "Unpriced";

/** A 0 to 1 share as the intent pages print it (`pct` in components/intents/v2/TopicsTable.tsx): a whole percent. */
export function formatWholePercent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/** A task's cost per run as its page prints it (`costStat` in components/tasks/TaskView.tsx). */
function formatTaskCost(cost: unknown): string {
  const view = (cost ?? {}) as { kind?: unknown; perRun?: unknown };
  if (view.kind === "estimated" && typeof view.perRun === "number")
    return `~${formatTaskMoney(view.perRun)}`;
  if (view.kind === "measured")
    return typeof view.perRun === "number" ? formatTaskMoney(view.perRun) : "Not priced";
  return MISSING;
}

export function formatValue(
  value: unknown,
  format: CellFormat = "text",
  context: FormatContext = "table",
  now: Date = new Date(),
): string {
  if (format === "currency") {
    if (value === null) return UNPRICED;
    if (value === undefined || value === "") return MISSING;
    return formatMoney(value as number | string);
  }
  if (value === null || value === undefined || value === "") return MISSING;
  switch (format) {
    case "number":
    case "bar": {
      const number = Number(value);
      if (!Number.isFinite(number)) return MISSING;
      return context === "stat"
        ? formatCompact(number)
        : Number.isInteger(number)
          ? formatInteger(number)
          : trimmed(number);
    }
    case "duration":
      return formatDuration(Number(value));
    case "percent":
      return formatPercent(Number(value));
    case "date": {
      const text = String(value);
      if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return formatDay(text);
      return context === "table" ? formatRelativeTime(text, now) : formatTimestamp(text);
    }
    case "id":
      return shortId(String(value));
    case "relative":
      return formatRelativeTime(String(value), now);
    case "meter":
    case "whole": {
      const share = Number(value);
      return Number.isFinite(share) ? formatWholePercent(share) : MISSING;
    }
    case "share": {
      const share = Number(value);
      return Number.isFinite(share) ? formatShare(share) : MISSING;
    }
    case "per100": {
      const rate = Number(value);
      return Number.isFinite(rate) ? formatPer100(rate) : MISSING;
    }
    case "taskCost":
      return formatTaskCost(value);
    case "points": {
      // Agent health's "If fixed" column: whole points, and a dash under one.
      const points = Number(value);
      return Number.isFinite(points) && points >= 1
        ? `+${formatInteger(points)}${NBSP}pts`
        : MISSING;
    }
    case "tools":
      return Array.isArray(value) ? value.join(", ") : String(value);
    case "badge":
    case "entity":
    case "text":
    case "status":
    case "taskStatus":
    case "sentiment":
      return typeof value === "object" ? JSON.stringify(value) : String(value);
  }
}

function trimmed(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** The value a column sorts by: numbers as numbers, unpriced last, text case-insensitive. */
export function sortValue(value: unknown, format: CellFormat = "text"): number | string | null {
  if (value === null || value === undefined || value === "") return null;
  if (format === "sentiment") {
    const share = Number((value as { negativeShare?: unknown }).negativeShare);
    return Number.isFinite(share) ? share : null;
  }
  if (format === "tools") return Array.isArray(value) ? value.length : null;
  if (format === "date" || format === "relative") {
    const time = Date.parse(String(value));
    return Number.isFinite(time) ? time : String(value);
  }
  if (format === "taskCost") {
    const perRun = (value as { perRun?: unknown }).perRun;
    return typeof perRun === "number" ? perRun : null;
  }
  if (
    format === "number" ||
    format === "currency" ||
    format === "duration" ||
    format === "percent" ||
    format === "bar" ||
    format === "meter" ||
    format === "share" ||
    format === "whole" ||
    format === "per100" ||
    format === "points"
  ) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  return String(value).toLowerCase();
}

/** Compare two rows' values; missing values sort last whatever the direction. */
export function compareValues(
  a: number | string | null,
  b: number | string | null,
  direction: "asc" | "desc",
): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const order =
    typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));
  return direction === "asc" ? order : -order;
}

/** Aggregate a series' values for a stat. */
export function aggregate(
  values: readonly unknown[],
  how: "sum" | "avg" | "max" | "last",
): number | null {
  const numbers = values.map(Number).filter((value) => Number.isFinite(value));
  if (numbers.length === 0) return null;
  switch (how) {
    case "sum":
      return numbers.reduce((total, value) => total + value, 0);
    case "avg":
      return numbers.reduce((total, value) => total + value, 0) / numbers.length;
    case "max":
      return Math.max(...numbers);
    case "last":
      return numbers[numbers.length - 1];
  }
}
