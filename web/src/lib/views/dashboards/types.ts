import { type MetricQuery, QUERY_KINDS, type Query } from "@/lib/contracts/query";
import type { RangePreset } from "@/lib/synthesis/dashboard";
import type { QueryResult } from "@/lib/synthesis/metrics/query";
import type { TraceFilter } from "@/lib/synthesis/traces/trace-filters";

/** What a widget can show: every kind. Kind `sql` is behind the `rql` flag. */
export type WidgetQuery = Query;
export type WidgetKind = WidgetQuery["kind"];
export const WIDGET_KINDS = QUERY_KINDS;
export const RQL_OFF_PROBLEM =
  "RQL is off for this project, so a widget of kind sql cannot be saved.";

/** Why RQL refused a query of kind sql: its message, its stable code and the fix. */
export interface WidgetRefusal {
  kind: "refused";
  message: string;
  code: string;
  fix: string;
}

/** What a widget shows: its numbers, or the refusal of its RQL text. */
export type WidgetResult = QueryResult | WidgetRefusal;

/** How a metric is drawn. Each other query kind has the one chart of its name. */
export const METRIC_CHARTS = ["line", "bar", "number", "table"] as const;
export type MetricChartKind = (typeof METRIC_CHARTS)[number];
export const WIDGET_CHARTS = [
  ...METRIC_CHARTS,
  "flow",
  "step_flow",
  "funnel",
  "clusters",
  "geography",
  // The rows of an RQL query: a table, or a chart when they have one time column.
  "sql",
] as const;
export type WidgetChart = (typeof WIDGET_CHARTS)[number];

/** Cells of the 12-column grid, from its top left. */
export interface GridPosition {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A widget as a person edits it. */
export interface WidgetInput {
  /** Shown instead of the query's own name, or empty. */
  title: string;
  query: WidgetQuery;
  chart: WidgetChart;
}

export type MetricWidget = WidgetInput & { query: MetricQuery };

export type Widget = WidgetInput & {
  id: string;
  layout: GridPosition;
  /** An imported widget whose scorer the project does not have: it shows no numbers until it is edited. */
  missingScorer?: string;
};

/** What every widget of a dashboard is narrowed by, on top of its own filters. */
export type DashboardFilters = Pick<TraceFilter, "environments" | "services" | "models" | "agents">;

/** What a dashboard opens with. */
export interface DashboardDefaults {
  filters: DashboardFilters;
  /** Null: the console's default. */
  range: RangePreset | null;
}

/** A stored item that is no widget under the contract. It can only be removed. */
export interface BrokenWidget {
  id: string;
  title: string;
  layout: GridPosition;
  /** Why it cannot be shown. */
  problem: string;
  /** What is stored, so that a change of another widget loses nothing. */
  stored: unknown;
}

export type DashboardWidget = Widget | BrokenWidget;

export interface Dashboard extends DashboardDefaults {
  id: string;
  name: string;
  widgets: DashboardWidget[];
  updatedAt: Date;
  /** Null for a person without a name. */
  updatedByName: string | null;
}

/** A dashboard without its widgets. */
export type DashboardSummary = Omit<Dashboard, "widgets"> & { widgetCount: number };

export const MAX_DASHBOARDS = 100;
export const MAX_WIDGETS = 24;
export const MAX_DASHBOARD_NAME = 80;
export const MAX_WIDGET_TITLE = 80;

/** Who makes a change, as it is stored with it. */
export interface DashboardEditor {
  updatedBy: string;
  updatedByName: string | null;
}
