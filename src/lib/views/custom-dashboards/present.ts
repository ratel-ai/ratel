import type { Pivot } from "@/lib/ingest/pivots/model";
import { fmtCost, fmtCount } from "@/lib/platform/format";
import {
  pivotKeyOf,
  type WidgetChart,
  type WidgetFixedGroupBy,
  type WidgetGroupBy,
  type WidgetMetric,
  type WidgetRangeDays,
} from "./spec";

/** The words and number formats of custom dashboards (RC-888), shared by the editor and the widgets. */

export const METRIC_LABELS: Record<WidgetMetric, string> = {
  runs: "Runs",
  error_rate: "Error rate",
  p50: "Median latency",
  p95: "p95 latency",
  tokens: "Tokens",
  cost: "Cost",
  sessions: "Sessions",
  distinct_users: "End users",
};

export const GROUP_BY_LABELS: Record<WidgetFixedGroupBy, string> = {
  day: "Day",
  model: "Model",
  tool: "Tool",
  service: "Service",
  environment: "Environment",
};

export const CHART_LABELS: Record<WidgetChart, string> = {
  kpi: "Number",
  line: "Line by day",
  bar: "Bars",
  table: "Table",
};

export const RANGE_LABELS: Record<WidgetRangeDays, string> = {
  1: "Last 24 hours",
  7: "Last 7 days",
  14: "Last 14 days",
  30: "Last 30 days",
};

/** The name of a group-by: a fixed one, or the label of its pivot (its key when the pivot is gone). */
export function groupByLabel(
  groupBy: WidgetGroupBy | null,
  pivots: readonly Pick<Pivot, "key" | "label">[],
): string {
  if (groupBy === null) return "None";
  const pivotKey = pivotKeyOf(groupBy);
  if (pivotKey === null) return GROUP_BY_LABELS[groupBy as WidgetFixedGroupBy];
  return pivots.find((pivot) => pivot.key === pivotKey)?.label ?? pivotKey;
}

/** A widget's title when it has none of its own: "Cost by Client company". */
export function widgetTitle(
  metric: WidgetMetric,
  groupBy: WidgetGroupBy | null,
  pivots: readonly Pick<Pivot, "key" | "label">[],
): string {
  return groupBy === null
    ? METRIC_LABELS[metric]
    : `${METRIC_LABELS[metric]} by ${groupByLabel(groupBy, pivots).toLowerCase()}`;
}

/** A metric value as people read it. null (no traces) reads as a dash. */
export function formatMetric(metric: WidgetMetric, value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "–";
  switch (metric) {
    case "error_rate":
      return `${(value * 100).toFixed(value === 0 || value >= 0.1 ? 0 : 1)}%`;
    case "p50":
    case "p95":
      return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`;
    case "tokens":
      return compact(value);
    case "cost":
      return fmtCost(value);
    case "runs":
    case "sessions":
    case "distinct_users":
      return fmtCount(value);
  }
}

/**
 * Groups in drawing order for bars and tables: highest value first, a group
 * with no value last, ties by runs. The query picks the top N by runs; this
 * orders what it picked by the metric the widget shows.
 */
export function byValueDesc<T extends { value: number | null; runs: number }>(
  groups: readonly T[],
): T[] {
  return [...groups].sort((a, b) => {
    if (a.value === null || b.value === null)
      return a.value === b.value ? b.runs - a.runs : a.value === null ? 1 : -1;
    return b.value - a.value || b.runs - a.runs;
  });
}

function compact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return fmtCount(value);
}
