import { type SQL, sql } from "drizzle-orm";
import { CONTEXT_SOURCES } from "@/lib/ingest/context";
import { getDb } from "@/lib/platform/db/client";
import {
  getMetric,
  MAX_METRIC_WINDOW_DAYS,
  METRIC_GROUP_LIMIT,
  type MetricAggregation,
  type MetricBucket,
  type MetricDefinition,
  type MetricGroupBy,
  type MetricId,
  type MetricRequest,
  MetricRequestError,
  metricBucket,
  metricSelectionProblem,
} from "@/lib/synthesis/metrics/catalog";
import { type TraceFilter, traceFilterCondition } from "@/lib/synthesis/traces/trace-filters";

export type MetricsDb = Pick<ReturnType<typeof getDb>, "execute">;

export interface MetricSeries {
  /** The group's value, or null for an ungrouped request. */
  group: string | null;
  /** The group as people read it, when its value is an id. */
  label?: string;
  /** The whole window's value: never the sum of `values`, which a percentile does not allow. */
  total: number | null;
  /** Rows behind `total`: traces, or captured prompts. */
  samples: number;
  /** One value per bucket. Null where a rate, average or percentile has nothing to read. */
  values: (number | null)[];
}

export interface MetricResult {
  bucket: MetricBucket;
  /** Bucket starts, ISO 8601 in UTC, oldest first. */
  buckets: string[];
  /** One series ungrouped. Grouped: at most `METRIC_GROUP_LIMIT`, highest total first. */
  series: MetricSeries[];
}

/** A group-by is a column, or an array whose every value counts the row once. */
export interface MetricGroup {
  column: SQL;
  array: boolean;
  /** The values a trace filter keeps of this property. */
  filtered?: (filter: TraceFilter) => readonly string[] | undefined;
  /** The group's name, when the column is an id. */
  label?: SQL;
}

/** Where a source's rows are, and what each of its metrics reads off one. */
export interface MetricSourceQuery {
  /** Aliases the trace's summary as `s` when the source is filterable. */
  table: SQL;
  project: SQL;
  time: SQL;
  /** The scorer of a row, where there is one. */
  scorer?: SQL;
  /** A count needs no more than the row. `where` keeps the rows the metric applies to. */
  measures: Partial<Record<MetricId, { value: SQL; where?: SQL }>>;
  groups: Partial<Record<MetricGroupBy, MetricGroup>>;
}

type Row = {
  grp: string;
  label: string | null;
  bucket: string | null;
  value: number | string | null;
  samples: number | string;
};

const STEP_MS: Record<MetricBucket, number> = { hour: 3_600_000, day: 86_400_000 };

const TRACE_TOKENS = sql`s.input_tokens + s.output_tokens`;
const CONTEXT_TOKENS = sql.join(
  CONTEXT_SOURCES.map((source) => sql`coalesce((s.tokens_by_category ->> ${source})::numeric, 0)`),
  sql` + `,
);

const AGGREGATES: Record<MetricAggregation, SQL> = {
  count: sql`count(*)`,
  rate: sql`avg(m)`,
  sum: sql`sum(m)`,
  avg: sql`avg(m)`,
  p50: sql`percentile_cont(0.5) within group (order by m)`,
  p95: sql`percentile_cont(0.95) within group (order by m)`,
};

/** The trace properties a row can be grouped by: columns of the trace's summary `s`. */
export const SUMMARY_GROUPS = {
  model: { column: sql`s.models`, array: true, filtered: (f) => f.models },
  tool: { column: sql`s.tools`, array: true, filtered: (f) => f.tools },
  agent: { column: sql`s.agents`, array: true, filtered: (f) => f.agents },
  service: { column: sql`s.service_name`, array: false, filtered: (f) => f.services },
  environment: { column: sql`s.environment`, array: false, filtered: (f) => f.environments },
} as const satisfies Partial<Record<MetricGroupBy, MetricGroup>>;

const SOURCES: Record<"traces" | "context", MetricSourceQuery> = {
  traces: {
    table: sql`otel_trace_summaries s`,
    project: sql`s.project_id`,
    time: sql`s.started_at`,
    measures: {
      trace_count: { value: sql`1` },
      error_rate: { value: sql`case when coalesce(s.root_error, s.has_error) then 1 else 0 end` },
      latency: { value: sql`s.duration_ms` },
      tokens: { value: TRACE_TOKENS },
      cost: { value: sql`s.cost_usd` },
    },
    groups: SUMMARY_GROUPS,
  },
  context: {
    table: sql`event_metrics s`,
    project: sql`s.project_id`,
    time: sql`s.event_time`,
    measures: {
      context_tokens: { value: CONTEXT_TOKENS },
      context_cost: { value: sql`coalesce(s.cost_usd, 0)` },
    },
    groups: {},
  },
};

/**
 * The sources whose tables a higher layer owns. Empty until that module fills it: the scorers
 * (`views/scorers/metrics`) fill `scores`.
 */
export const metricSeams: { scores?: MetricSourceQuery } = {};

/**
 * The one metric query: any catalog entry over a window, filtered and grouped. Dashboards and
 * alerts both call it. Throws `MetricRequestError` for a request the catalog does not allow.
 */
export async function queryMetric(
  projectId: string,
  request: MetricRequest,
  db: MetricsDb = getDb(),
): Promise<MetricResult> {
  const { metric, aggregation, groupBy, bucket } = checked(request);
  const result = await db.execute(
    metricQuery(projectId, metric, aggregation, groupBy, bucket, request),
  );
  const rows = ((result as unknown as { rows?: unknown[] }).rows ??
    (result as unknown as unknown[])) as Row[];
  const buckets = bucketStarts(request.window, bucket);
  return { bucket, buckets, series: toSeries(rows, buckets, aggregation, groupBy !== null) };
}

function checked(request: MetricRequest) {
  const problem = metricSelectionProblem(request);
  if (problem) throw new MetricRequestError(problem);
  const metric = getMetric(request.metric) as MetricDefinition;
  const { since, until } = request.window;
  const span = until.getTime() - since.getTime();
  if (!(span > 0)) throw new MetricRequestError("The window is empty.");
  if (span > MAX_METRIC_WINDOW_DAYS * STEP_MS.day) {
    throw new MetricRequestError(`The window is longer than ${MAX_METRIC_WINDOW_DAYS} days.`);
  }
  const bucket = request.bucket ?? metricBucket(metric, request.window);
  if (!metric.buckets.includes(bucket)) {
    throw new MetricRequestError(`${metric.label} has no ${bucket} buckets.`);
  }
  return {
    metric,
    aggregation: request.aggregation as MetricAggregation,
    groupBy: (request.groupBy || null) as MetricGroupBy | null,
    bucket,
  };
}

/** Per group: one row per bucket and one (`bucket` null) for the window, read in one pass. */
function metricQuery(
  projectId: string,
  metric: MetricDefinition,
  aggregation: MetricAggregation,
  groupBy: MetricGroupBy | null,
  bucket: MetricBucket,
  { window, filter, scorerId }: MetricRequest,
): SQL {
  const source = metric.source === "scores" ? metricSeams.scores : SOURCES[metric.source];
  const measure = source?.measures[metric.id];
  const group = groupBy ? source?.groups[groupBy] : null;
  // The catalog allowed the request, so a hole here is a module that was not loaded.
  if (!source || !measure || group === undefined) {
    throw new Error(`the metric source "${metric.source}" cannot answer "${metric.id}"`);
  }
  const { table, time } = source;
  const join = group?.array
    ? sql`cross join lateral (select distinct v from unnest(${group.column}) v) g`
    : sql``;
  const grp = group ? (group.array ? sql`g.v` : group.column) : sql`''::text`;
  const condition = metric.filterable ? traceFilterCondition(filter) : null;
  const only = [...(group?.filtered?.(filter ?? {}) ?? [])];
  return sql`
    with measured as (
      select ${grp} as grp, ${group?.label ?? sql`null::text`} as label,
        to_char(date_trunc(${sql.raw(`'${bucket}'`)}, ${time} at time zone 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS".000Z"') as bucket,
        ${measure.value} as m
      from ${table} ${join}
      where ${source.project} = ${projectId}
        and ${time} >= ${window.since.toISOString()}::timestamptz
        and ${time} < ${window.until.toISOString()}::timestamptz
        ${measure.where ? sql`and ${measure.where}` : sql``}
        ${scorerId && source.scorer ? sql`and ${source.scorer} = ${scorerId}::uuid` : sql``}
        ${condition ? sql`and ${condition}` : sql``}
        ${group ? sql`and ${grp} is not null` : sql``}
        ${
          only.length > 0
            ? sql`and ${grp} = any(array[${sql.join(
                only.map((value) => sql`${value.trim()}`),
                sql`, `,
              )}]::text[])`
            : sql``
        }
    ),
    aggregated as (
      select grp, bucket, max(label) as label, (${AGGREGATES[aggregation]})::float8 as value, count(*)::int as samples
      from measured
      group by grouping sets ((grp, bucket), (grp))
    ),
    top as (
      select grp, row_number() over (order by value desc nulls last, grp collate "C") as rank
      from aggregated where bucket is null
    )
    select a.grp, a.label, a.bucket, a.value, a.samples
    from aggregated a join top t on t.grp = a.grp
    where t.rank <= ${METRIC_GROUP_LIMIT}
    order by t.rank, a.bucket nulls first`;
}

function toSeries(
  rows: Row[],
  buckets: string[],
  aggregation: MetricAggregation,
  grouped: boolean,
): MetricSeries[] {
  // Nothing happened is 0 for an amount, and no answer for a ratio.
  const nothing = aggregation === "count" || aggregation === "sum" ? 0 : null;
  const indexOf = new Map(buckets.map((start, index) => [start, index]));
  const byGroup = new Map<string, MetricSeries>();
  const seriesOf = (grp: string, label: string | null = null) => {
    let series = byGroup.get(grp);
    if (!series) {
      series = {
        group: grouped ? grp : null,
        ...(label ? { label } : {}),
        total: nothing,
        samples: 0,
        values: buckets.map(() => nothing),
      };
      byGroup.set(grp, series);
    }
    return series;
  };
  if (!grouped) seriesOf("");
  for (const row of rows) {
    const series = seriesOf(row.grp, row.label);
    const value = row.value === null ? nothing : Number(row.value);
    if (row.bucket === null) {
      series.total = value;
      series.samples = Number(row.samples);
      continue;
    }
    const index = indexOf.get(row.bucket);
    if (index !== undefined) series.values[index] = value;
  }
  return withDistinctLabels([...byGroup.values()]);
}

/** Two groups of one name are told apart by the start of their id. */
function withDistinctLabels(series: MetricSeries[]): MetricSeries[] {
  const counts = new Map<string, number>();
  for (const { label } of series) if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
  return series.map((item) =>
    item.label && (counts.get(item.label) ?? 0) > 1
      ? { ...item, label: `${item.label} (${item.group?.slice(0, 8)})` }
      : item,
  );
}

/** Every bucket the window touches, so a gap in the data is a gap in the series. */
function bucketStarts({ since, until }: MetricRequest["window"], bucket: MetricBucket): string[] {
  const step = STEP_MS[bucket];
  const starts: string[] = [];
  for (let at = Math.floor(since.getTime() / step) * step; at < until.getTime(); at += step) {
    starts.push(new Date(at).toISOString());
  }
  return starts;
}
