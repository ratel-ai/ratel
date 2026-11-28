import type { Aggregation } from "@/lib/contracts/query";
import { getMetric, type MetricUnit, nothingIsZero } from "@/lib/synthesis/metrics/catalog";
import type { AlertCondition, AlertQuery, AlertState, AlertWindow } from "@/lib/views/alerts/types";
import { formatMetric } from "@/lib/views/dashboards/chart-model";
import { queryName } from "@/lib/views/dashboards/widget";

/** How an alert reads. Safe for the browser. */

export const STATE_LABELS: Readonly<Record<AlertState, string>> = {
  ok: "OK",
  alerting: "Alerting",
  no_data: "No data",
};

export const WINDOW_LABELS: Readonly<Record<AlertWindow, string>> = {
  5: "5 minutes",
  15: "15 minutes",
  60: "1 hour",
  1440: "1 day",
};

/** "Latency p95 is above 2s over 5 minutes" */
export function conditionText(
  { query }: { query: AlertQuery | null },
  condition: AlertCondition,
): string {
  const unit = unitOf(query);
  return `${query ? queryName(query) : "The value"} is ${condition.operator} ${measuredText(condition.threshold, unit)} over ${WINDOW_LABELS[condition.windowMinutes]}`;
}

/** Null without a query: its numbers have no unit. */
export function unitOf(query: AlertQuery | null): MetricUnit | null {
  // The number of RQL text has no unit the catalog knows.
  if (!query?.form) return null;
  return getMetric(query.form.measures[0].measure)?.unit ?? null;
}

/** A share keeps one decimal, so it does not read as its own threshold. */
export function measuredText(value: number, unit: MetricUnit | null): string {
  if (unit === null) return String(value);
  if (unit === "ratio") return `${Number((value * 100).toFixed(1))}%`;
  return formatMetric(value, unit);
}

/** A ratio is typed as a percentage; every other unit as it is stored. */
export function thresholdInput(threshold: number, unit: MetricUnit): string {
  return String(unit === "ratio" ? Number((threshold * 100).toFixed(6)) : threshold);
}

/** Null when the text is not a number of 0 or more. */
export function thresholdFrom(text: string, unit: MetricUnit): number | null {
  if (text.trim() === "") return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) return null;
  return unit === "ratio" ? value / 100 : value;
}

export function thresholdUnit(unit: MetricUnit): string {
  return {
    count: "",
    ratio: "%",
    ms: "ms",
    tokens: "tokens",
    usd: "USD",
    score: "of 5",
    number: "",
  }[unit];
}

/** What the window of an alert reads, for the form. */
export function alertWindowText(aggregation: Aggregation): string {
  return [
    "A trace counts when it ends and a scorer result when it is stored, so a trace longer than the window counts too.",
    nothingIsZero(aggregation)
      ? "With nothing in the window, the value is 0."
      : "With nothing in the window, the alert has no data.",
  ].join(" ");
}
