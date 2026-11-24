import type { MetricAggregation, MetricGroupBy, MetricId } from "@/lib/synthesis/metrics/catalog";
import type { TraceFilter } from "@/lib/synthesis/traces/trace-filters";

export const WIDGET_CHARTS = ["line", "bar", "number", "table"] as const;
export type WidgetChart = (typeof WIDGET_CHARTS)[number];

export const WIDGET_WIDTHS = ["third", "half", "full"] as const;
export type WidgetWidth = (typeof WIDGET_WIDTHS)[number];

/** A widget as a person edits it. */
export interface WidgetInput {
  /** Shown instead of the metric's own name, or empty. */
  title: string;
  metric: MetricId;
  aggregation: MetricAggregation;
  groupBy: MetricGroupBy | null;
  filter: TraceFilter;
  chart: WidgetChart;
  width: WidgetWidth;
}

export type Widget = WidgetInput & { id: string };

export interface Dashboard {
  id: string;
  name: string;
  widgets: Widget[];
  updatedAt: Date;
}

export const MAX_DASHBOARDS = 100;
export const MAX_WIDGETS = 24;
export const MAX_DASHBOARD_NAME = 80;
export const MAX_WIDGET_TITLE = 80;
