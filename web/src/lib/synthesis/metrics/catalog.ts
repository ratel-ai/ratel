import {
  type Aggregation,
  type Bucket,
  type Dimension,
  MEASURE_IDS,
  MEASURES,
  type MeasureId,
} from "@/lib/contracts/query";
import type { TraceFilter } from "@/lib/synthesis/traces/trace-filters";

/**
 * The metric catalog: what a widget can measure. The query contract
 * (`contracts/query`) says what each measure allows; this adds how it reads and where it comes
 * from. Pure data, safe for the browser, so every form is built from it.
 */

export type MetricUnit = "count" | "ratio" | "ms" | "tokens" | "usd" | "score";

/** Where the numbers come from: one row per trace, one row per captured prompt, or one per scorer result. */
export type MetricSource = "traces" | "context" | "scores";
/** The switches an entry can wait for. */
export interface MetricFeatures {
  customMonitoring: boolean;
}

export interface MetricDefinition {
  id: MeasureId;
  label: string;
  description: string;
  unit: MetricUnit;
  source: MetricSource;
  /** The first one is the default. */
  aggregations: readonly Aggregation[];
  dimensions: readonly Dimension[];
  /** Whether trace filters apply. */
  filterable: boolean;
  /** Offered only with this switch on. */
  feature?: keyof MetricFeatures;
  /** The buckets the source can answer. */
  buckets: readonly Bucket[];
}

/** `until` is exclusive. A `ResolvedRange` fits. */
export interface QueryWindow {
  since: Date;
  until: Date;
}

/** What surrounds a query: the window it reads, and a filter that must match as well as its own. */
export interface QueryScope extends QueryWindow {
  /** Nothing for a measure that cannot be filtered. */
  filter?: TraceFilter;
}

/** The groups kept in a grouped result. */
export const METRIC_GROUP_LIMIT = 10;
/** A window up to this many days is read by the hour. */
export const HOURLY_WINDOW_DAYS = 3;
/** The longest window, in days: the trace ranges' own limit. */
export const MAX_METRIC_WINDOW_DAYS = 372;

const DAY_MS = 86_400_000;

const SCORER_METRIC = { source: "scores", feature: "customMonitoring" } as const;

const READS: Readonly<
  Record<MeasureId, Pick<MetricDefinition, "description" | "unit" | "source" | "feature">>
> = {
  trace_count: { source: "traces", unit: "count", description: "How many traces started." },
  error_rate: { source: "traces", unit: "ratio", description: "The share of traces that failed." },
  latency: { source: "traces", unit: "ms", description: "How long a trace took." },
  tokens: {
    source: "traces",
    unit: "tokens",
    description: "Input and output tokens of the traces.",
  },
  cost: { source: "traces", unit: "usd", description: "Model cost of the traces." },
  context_tokens: {
    source: "context",
    unit: "tokens",
    description: "Input tokens of the captured prompts, as on Overview.",
  },
  context_cost: {
    source: "context",
    unit: "usd",
    description: "Cost of the captured prompts, as on Overview.",
  },
  scorer_pass_rate: {
    ...SCORER_METRIC,
    unit: "ratio",
    description: "The share of results that passed, of the pass or fail scorers.",
  },
  scorer_average: {
    ...SCORER_METRIC,
    unit: "score",
    description: "The average result of the scorers that answer 1 to 5.",
  },
  scorer_count: {
    ...SCORER_METRIC,
    unit: "count",
    description: "How many results the scorers stored: one per scorer and trace.",
  },
};

/** The catalog in menu order. */
export const METRICS: readonly MetricDefinition[] = MEASURE_IDS.map((id) => ({
  id,
  ...MEASURES[id],
  ...READS[id],
}));

/** Whether a project with these switches may use the entry. */
export function metricOffered(metric: MetricDefinition, features: MetricFeatures): boolean {
  return !metric.feature || features[metric.feature];
}

/** The entries a form offers, in menu order. */
export function offeredMetrics(features: MetricFeatures): MetricDefinition[] {
  return METRICS.filter((metric) => metricOffered(metric, features));
}

export function getMetric(id: string): MetricDefinition | null {
  return METRICS.find((metric) => metric.id === id) ?? null;
}

/** The bucket of a window: hours for a few days, else days, within what the metric can answer. */
export function metricBucket(metric: MetricDefinition, window: QueryWindow): Bucket {
  const days = (window.until.getTime() - window.since.getTime()) / DAY_MS;
  const bucket: Bucket = days <= HOURLY_WINDOW_DAYS ? "hour" : "day";
  return metric.buckets.includes(bucket) ? bucket : metric.buckets[0];
}
