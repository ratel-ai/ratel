import type { TraceFilter } from "@/lib/synthesis/traces/trace-filters";

/**
 * The metric catalog: what a widget or an alert can measure. Pure data and checks, safe for the
 * browser, so every form is built from it. `query.ts` runs a request.
 */

export const METRIC_IDS = [
  "trace_count",
  "error_rate",
  "latency",
  "tokens",
  "cost",
  "context_tokens",
  "context_cost",
  "scorer_pass_rate",
  "scorer_average",
  "scorer_count",
] as const;
export type MetricId = (typeof METRIC_IDS)[number];

export const METRIC_AGGREGATIONS = ["count", "rate", "sum", "avg", "p50", "p95"] as const;
export type MetricAggregation = (typeof METRIC_AGGREGATIONS)[number];

export const METRIC_GROUP_BYS = [
  "model",
  "service",
  "environment",
  "agent",
  "tool",
  "scorer",
] as const;
export type MetricGroupBy = (typeof METRIC_GROUP_BYS)[number];

export type MetricUnit = "count" | "ratio" | "ms" | "tokens" | "usd" | "score";
export type MetricBucket = "hour" | "day";

/** Where the numbers come from: one row per trace, one row per captured prompt, or one per scorer result. */
export type MetricSource = "traces" | "context" | "scores";
/** The switches an entry can wait for. */
export interface MetricFeatures {
  scorers: boolean;
}

export interface MetricDefinition {
  id: MetricId;
  label: string;
  description: string;
  unit: MetricUnit;
  source: MetricSource;
  /** The first one is the default. */
  aggregations: readonly MetricAggregation[];
  groupBys: readonly MetricGroupBy[];
  /** Whether a `TraceFilter` applies. */
  filterable: boolean;
  /** Offered only with this switch on. */
  feature?: keyof MetricFeatures;
  /** The buckets the source can answer. */
  buckets: readonly MetricBucket[];
}

export interface MetricRequest {
  metric: string;
  aggregation: string;
  groupBy?: string | null;
  filter?: TraceFilter;
  /** A scorer metric: that scorer's results only. */
  scorerId?: string | null;
  /** `until` is exclusive. A `ResolvedRange` fits. */
  window: { since: Date; until: Date };
  /** Chosen from the window when absent. */
  bucket?: MetricBucket;
}

/** Why a request is refused. */
export class MetricRequestError extends Error {
  override name = "MetricRequestError";
}

/** The groups kept in a grouped result. */
export const METRIC_GROUP_LIMIT = 10;
/** A window up to this many days is read by the hour. */
export const HOURLY_WINDOW_DAYS = 3;
/** The longest window, in days: the trace ranges' own limit. */
export const MAX_METRIC_WINDOW_DAYS = 372;

const DAY_MS = 86_400_000;

const TRACE_METRIC = {
  source: "traces",
  groupBys: ["model", "service", "environment", "agent", "tool"],
  filterable: true,
  buckets: ["hour", "day"],
} as const;
const CONTEXT_METRIC = {
  source: "context",
  groupBys: [],
  filterable: false,
  buckets: ["day"],
} as const;
const SCORER_METRIC = {
  source: "scores",
  feature: "scorers",
  groupBys: ["scorer", "model", "service", "environment"],
  filterable: true,
  buckets: ["hour", "day"],
} as const;
const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export const METRIC_CATALOG: Readonly<Record<MetricId, MetricDefinition>> = {
  trace_count: {
    ...TRACE_METRIC,
    id: "trace_count",
    label: "Traces",
    description: "How many traces started.",
    unit: "count",
    aggregations: ["count"],
  },
  error_rate: {
    ...TRACE_METRIC,
    id: "error_rate",
    label: "Error rate",
    description: "The share of traces that failed.",
    unit: "ratio",
    aggregations: ["rate"],
  },
  latency: {
    ...TRACE_METRIC,
    id: "latency",
    label: "Latency",
    description: "How long a trace took.",
    unit: "ms",
    aggregations: ["p50", "p95"],
  },
  tokens: {
    ...TRACE_METRIC,
    id: "tokens",
    label: "Tokens",
    description: "Input and output tokens of the traces.",
    unit: "tokens",
    aggregations: ["sum", "avg"],
  },
  cost: {
    ...TRACE_METRIC,
    id: "cost",
    label: "Cost",
    description: "Model cost of the traces.",
    unit: "usd",
    aggregations: ["sum", "avg"],
  },
  context_tokens: {
    ...CONTEXT_METRIC,
    id: "context_tokens",
    label: "Context tokens",
    description: "Input tokens of the captured prompts, as on Overview.",
    unit: "tokens",
    aggregations: ["sum"],
  },
  context_cost: {
    ...CONTEXT_METRIC,
    id: "context_cost",
    label: "Context cost",
    description: "Cost of the captured prompts, as on Overview.",
    unit: "usd",
    aggregations: ["sum"],
  },
  scorer_pass_rate: {
    ...SCORER_METRIC,
    id: "scorer_pass_rate",
    label: "Scorer pass rate",
    description: "The share of results that passed, of the pass or fail scorers.",
    unit: "ratio",
    aggregations: ["rate"],
  },
  scorer_average: {
    ...SCORER_METRIC,
    id: "scorer_average",
    label: "Scorer average",
    description: "The average result of the scorers that answer 1 to 5.",
    unit: "score",
    aggregations: ["avg"],
  },
  scorer_count: {
    ...SCORER_METRIC,
    id: "scorer_count",
    label: "Scorer results",
    description: "How many results the scorers stored: one per scorer and trace.",
    unit: "count",
    aggregations: ["count"],
  },
};

/** The catalog in menu order. */
export const METRICS: readonly MetricDefinition[] = METRIC_IDS.map((id) => METRIC_CATALOG[id]);

/** Whether a project with these switches may use the entry. */
export function metricOffered(metric: MetricDefinition, features: MetricFeatures): boolean {
  return !metric.feature || features[metric.feature];
}

/** The entries a form offers, in menu order. */
export function offeredMetrics(features: MetricFeatures): MetricDefinition[] {
  return METRICS.filter((metric) => metricOffered(metric, features));
}

export function getMetric(id: string): MetricDefinition | null {
  return (METRIC_IDS as readonly string[]).includes(id) ? METRIC_CATALOG[id as MetricId] : null;
}

export type MetricSelection = Pick<
  MetricRequest,
  "metric" | "aggregation" | "groupBy" | "filter" | "scorerId"
>;

/** What the catalog does not allow in a selection, or null. The stored half of a request. */
export function metricSelectionProblem(selection: MetricSelection): string | null {
  const metric = getMetric(selection.metric);
  if (!metric) return `Unknown metric "${selection.metric}".`;
  if (!(metric.aggregations as readonly string[]).includes(selection.aggregation)) {
    return `${metric.label} cannot be aggregated by "${selection.aggregation}".`;
  }
  if (selection.groupBy && !(metric.groupBys as readonly string[]).includes(selection.groupBy)) {
    return `${metric.label} cannot be grouped by "${selection.groupBy}".`;
  }
  if (!metric.filterable && !isEmptyTraceFilter(selection.filter)) {
    return `${metric.label} cannot be filtered.`;
  }
  if (selection.scorerId) {
    if (metric.source !== "scores") return `${metric.label} cannot be filtered by scorer.`;
    if (!UUID.test(selection.scorerId)) return "Unknown scorer.";
  }
  return null;
}

export function isEmptyTraceFilter(filter: TraceFilter | undefined): boolean {
  return Object.values(filter ?? {}).every(
    (value) => value === undefined || (Array.isArray(value) && value.length === 0),
  );
}

/** The bucket of a window: hours for a few days, else days, within what the metric can answer. */
export function metricBucket(
  metric: MetricDefinition,
  window: MetricRequest["window"],
): MetricBucket {
  const days = (window.until.getTime() - window.since.getTime()) / DAY_MS;
  const bucket = days <= HOURLY_WINDOW_DAYS ? "hour" : "day";
  return metric.buckets.includes(bucket) ? bucket : metric.buckets[0];
}
