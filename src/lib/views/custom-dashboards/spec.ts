import { z } from "zod";
import type { Pivot } from "@/lib/ingest/pivots/model";
import type { TraceFilter } from "@/lib/synthesis/traces/trace-filters";

/**
 * The widget spec of a custom dashboard (RC-887, `cloud-custom-dashboards`).
 * Pure domain: what a widget may ask of `otel_trace_summaries`. Every field is
 * a value from a fixed whitelist, except the filter values and the pivot key,
 * which the query only ever binds as parameters (./query.ts).
 */

export const WIDGET_METRICS = [
  "runs",
  "error_rate",
  "p50",
  "p95",
  "tokens",
  "cost",
  "sessions",
  "distinct_users",
] as const;
export const WIDGET_CHARTS = ["kpi", "line", "bar", "table"] as const;
/** The group-bys that need no pivot. `pivot:<key>` is the other form. */
export const WIDGET_FIXED_GROUP_BYS = ["day", "model", "tool", "service", "environment"] as const;
/** Day counts a widget may read. The longest is the retention window of raw telemetry. */
export const WIDGET_RANGE_DAYS = [1, 7, 14, 30] as const;
export const RETENTION_DAYS = 30;
export const DEFAULT_TOP_N = 20;
export const MAX_TOP_N = 50;
export const PIVOT_GROUP_PREFIX = "pivot:";
/** The pivot presets the distinct-count metrics read (lib/pivots/model.ts). */
export const METRIC_PIVOT_PRESET = { sessions: "session", distinct_users: "end_user" } as const;

const MAX_FILTER_VALUES = 50;
const MAX_FILTER_VALUE_LENGTH = 200;
const MAX_PIVOT_KEY_LENGTH = 128;

export type WidgetMetric = (typeof WIDGET_METRICS)[number];
export type WidgetChart = (typeof WIDGET_CHARTS)[number];
export type WidgetFixedGroupBy = (typeof WIDGET_FIXED_GROUP_BYS)[number];
export type WidgetGroupBy = WidgetFixedGroupBy | `pivot:${string}`;
export type WidgetRangeDays = (typeof WIDGET_RANGE_DAYS)[number];

export interface WidgetSpec {
  metric: WidgetMetric;
  /** null: one total (a KPI). */
  groupBy: WidgetGroupBy | null;
  filter: TraceFilter;
  chart: WidgetChart;
  /** The last N days, a preset. */
  rangeDays: WidgetRangeDays;
  /** Groups kept before "Other". DEFAULT_TOP_N when absent, at most MAX_TOP_N. Never set for a day grouping. */
  topN?: number;
}

export type WidgetSpecError =
  | "invalid_spec"
  | "unknown_metric"
  | "unknown_group_by"
  | "unknown_chart"
  | "invalid_filter"
  | "invalid_range"
  | "range_over_retention"
  | "invalid_top_n"
  | "chart_group_by_mismatch"
  | "unconfigured_pivot";

export type WidgetSpecResult =
  | { ok: true; spec: WidgetSpec }
  | { ok: false; error: WidgetSpecError };

/** What the spec is checked against: the project's configured pivots. */
export interface WidgetSpecContext {
  pivots: readonly Pick<Pivot, "key" | "presetId">[];
}

const filterValues = z
  .array(z.string().trim().min(1).max(MAX_FILTER_VALUE_LENGTH))
  .max(MAX_FILTER_VALUES);
const filterSchema = z.strictObject({
  models: filterValues.optional(),
  tools: filterValues.optional(),
  services: filterValues.optional(),
  environments: filterValues.optional(),
  agents: filterValues.optional(),
  mcpServers: filterValues.optional(),
  status: z.enum(["failed", "ok"]).optional(),
  minCostUsd: z.number().finite().nonnegative().optional(),
  minTokens: z.number().int().nonnegative().optional(),
});
const groupBySchema = z.union([
  z.enum(WIDGET_FIXED_GROUP_BYS),
  z
    .string()
    .regex(/^pivot:[A-Za-z0-9_.\-:/]+$/)
    .max(PIVOT_GROUP_PREFIX.length + MAX_PIVOT_KEY_LENGTH),
]);

/**
 * Check a widget spec against the whitelist and the project's pivots. The one
 * gate before a spec is stored or queried.
 */
export function validateWidgetSpec(input: unknown, context: WidgetSpecContext): WidgetSpecResult {
  const parsed = parseWidgetSpec(input);
  if (!parsed.ok) return parsed;
  const pivot = pivotKeyOf(parsed.spec.groupBy);
  if (pivot !== null && !context.pivots.some((configured) => configured.key === pivot)) {
    return { ok: false, error: "unconfigured_pivot" };
  }
  return parsed;
}

/**
 * The shape and whitelist check alone, without the project's pivots: what a
 * stored widget is read with, so a pivot removed since reads "pivot missing"
 * at query time instead of failing.
 */
export function parseWidgetSpec(input: unknown): WidgetSpecResult {
  if (!isRecord(input)) return { ok: false, error: "invalid_spec" };
  const allowed = new Set(["metric", "groupBy", "filter", "chart", "rangeDays", "topN"]);
  if (Object.keys(input).some((key) => !allowed.has(key)))
    return { ok: false, error: "invalid_spec" };

  const metric = z.enum(WIDGET_METRICS).safeParse(input.metric);
  if (!metric.success) return { ok: false, error: "unknown_metric" };
  const groupBy =
    input.groupBy === null || input.groupBy === undefined
      ? null
      : groupBySchema.safeParse(input.groupBy);
  if (groupBy && !groupBy.success) return { ok: false, error: "unknown_group_by" };
  const chart = z.enum(WIDGET_CHARTS).safeParse(input.chart);
  if (!chart.success) return { ok: false, error: "unknown_chart" };
  const filter = filterSchema.safeParse(input.filter ?? {});
  if (!filter.success) return { ok: false, error: "invalid_filter" };
  const range = checkRange(input.rangeDays);
  if (!range.ok) return range;
  const topN =
    input.topN === undefined
      ? undefined
      : z.number().int().min(1).max(MAX_TOP_N).safeParse(input.topN);
  if (topN && !topN.success) return { ok: false, error: "invalid_top_n" };

  const spec: WidgetSpec = {
    metric: metric.data,
    groupBy: groupBy ? (groupBy.data as WidgetGroupBy) : null,
    filter: filter.data,
    chart: chart.data,
    rangeDays: range.days,
    // A day grouping is a time series: no Other, its cap is the range.
    ...(topN && groupBy?.data !== "day" ? { topN: topN.data } : {}),
  };
  if (!chartFitsGroupBy(spec.chart, spec.groupBy))
    return { ok: false, error: "chart_group_by_mismatch" };
  return { ok: true, spec };
}

/** The pivot key of a `pivot:<key>` group-by, or null. */
export function pivotKeyOf(groupBy: WidgetGroupBy | null): string | null {
  return groupBy?.startsWith(PIVOT_GROUP_PREFIX) ? groupBy.slice(PIVOT_GROUP_PREFIX.length) : null;
}

/**
 * Which charts draw which group-bys: a KPI is one total, a line is a series
 * over days, a bar compares groups, a table shows either.
 */
export function chartFitsGroupBy(chart: WidgetChart, groupBy: WidgetGroupBy | null): boolean {
  switch (chart) {
    case "kpi":
      return groupBy === null;
    case "line":
      return groupBy === "day";
    case "bar":
      return groupBy !== null;
    case "table":
      return true;
  }
}

/** The groups a widget keeps before "Other". */
export function topNOf(spec: Pick<WidgetSpec, "topN">): number {
  return spec.topN ?? DEFAULT_TOP_N;
}

function checkRange(
  value: unknown,
): { ok: true; days: WidgetRangeDays } | { ok: false; error: WidgetSpecError } {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
    return { ok: false, error: "invalid_range" };
  if (value > RETENTION_DAYS) return { ok: false, error: "range_over_retention" };
  const preset = WIDGET_RANGE_DAYS.find((days) => days === value);
  return preset ? { ok: true, days: preset } : { ok: false, error: "invalid_range" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
