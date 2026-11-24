import {
  getMetric,
  type MetricAggregation,
  type MetricGroupBy,
} from "@/lib/synthesis/metrics/catalog";
import type { TraceFilter } from "@/lib/synthesis/traces/trace-filters";
import type { WidgetChart, WidgetInput } from "@/lib/views/dashboards/types";

/** What fits a widget, and how it is named. Safe for the browser. */

export const CHART_LABELS: Readonly<Record<WidgetChart, string>> = {
  line: "Line",
  bar: "Bar",
  number: "Number",
  table: "Table",
};

const AGGREGATION_LABELS: Readonly<Record<MetricAggregation, string>> = {
  count: "Count",
  rate: "Rate",
  sum: "Total",
  avg: "Average per trace",
  p50: "p50",
  p95: "p95",
};

const GROUP_BY_LABELS: Readonly<Record<MetricGroupBy, string>> = {
  model: "Model",
  service: "Service",
  environment: "Environment",
  agent: "Agent",
  tool: "Tool",
};

/** Why a chart does not fit the grouping, or null. */
export function chartProblem({ chart, groupBy }: Pick<WidgetInput, "chart" | "groupBy">) {
  if (chart === "table" && !groupBy) return "A table needs a group-by.";
  if (chart === "number" && groupBy) return "A number cannot be grouped.";
  return null;
}

/** The nearest widget the rules allow: what the editor shows after one field changes. */
export function fitWidget(widget: WidgetInput): WidgetInput {
  const metric = getMetric(widget.metric);
  if (!metric) return widget;
  const groupBys = metric.groupBys as readonly MetricGroupBy[];
  let groupBy = widget.groupBy && groupBys.includes(widget.groupBy) ? widget.groupBy : null;
  let chart = widget.chart;
  if (chart === "number") groupBy = null;
  if (chart === "table" && !groupBy) {
    groupBy = groupBys[0] ?? null;
    if (!groupBy) chart = "line";
  }
  const aggregations = metric.aggregations as readonly MetricAggregation[];
  return {
    ...widget,
    chart,
    groupBy,
    aggregation: aggregations.includes(widget.aggregation) ? widget.aggregation : aggregations[0],
    filter: metric.filterable ? widget.filter : ({} as TraceFilter),
  };
}

export function aggregationLabel(aggregation: MetricAggregation): string {
  return AGGREGATION_LABELS[aggregation];
}

export function groupByLabel(groupBy: MetricGroupBy): string {
  return GROUP_BY_LABELS[groupBy];
}

/** "Latency p95 by model": the name of a widget without its own title. */
export function widgetName(widget: WidgetInput): string {
  if (widget.title) return widget.title;
  const metric = getMetric(widget.metric);
  const label = metric?.label ?? widget.metric;
  const aggregation =
    metric && metric.aggregations.length > 1 && widget.aggregation !== "sum"
      ? ` ${widget.aggregation === "avg" ? "per trace" : widget.aggregation}`
      : "";
  return `${label}${aggregation}${widget.groupBy ? ` by ${widget.groupBy}` : ""}`;
}
