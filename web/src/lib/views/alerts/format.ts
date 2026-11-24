import { getMetric, type MetricUnit } from "@/lib/synthesis/metrics/catalog";
import type { AlertCondition, AlertQuery, AlertState, AlertWindow } from "@/lib/views/alerts/types";
import { formatMetric } from "@/lib/views/dashboards/chart-model";
import { widgetName } from "@/lib/views/dashboards/widget";

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

/** "Latency p95" */
export function metricText({ metric, aggregation }: AlertQuery): string {
  return widgetName({
    title: "",
    metric,
    aggregation,
    groupBy: null,
    filter: {},
    chart: "line",
    width: "full",
  });
}

/** "Latency p95 is above 2s over 5 minutes" */
export function conditionText({ query }: { query: AlertQuery }, condition: AlertCondition): string {
  const unit = getMetric(query.metric)?.unit ?? "count";
  return `${metricText(query)} is ${condition.operator} ${measuredText(condition.threshold, unit)} over ${WINDOW_LABELS[condition.windowMinutes]}`;
}

/** A share keeps one decimal, so it does not read as its own threshold. */
export function measuredText(value: number, unit: MetricUnit): string {
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
  return { count: "", ratio: "%", ms: "ms", tokens: "tokens", usd: "USD", score: "of 5" }[unit];
}
