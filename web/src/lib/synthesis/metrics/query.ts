import { type SQL, sql } from "drizzle-orm";
import {
  type Aggregation,
  type Bucket,
  type Dimension,
  type MeasureId,
  type MetricQuery,
  parseQuery,
  type Query,
} from "@/lib/contracts/query";
import { CONTEXT_SOURCES } from "@/lib/ingest/context";
import { getDb } from "@/lib/platform/db/client";
import {
  getMetric,
  MAX_METRIC_WINDOW_DAYS,
  METRIC_GROUP_LIMIT,
  type MetricDefinition,
  metricBucket,
  type QueryScope,
  type QueryWindow,
} from "@/lib/synthesis/metrics/catalog";
import type { ClustersResult } from "@/lib/synthesis/metrics/clusters";
import { type FlowResult, runFlow } from "@/lib/synthesis/metrics/flow";
import type { FunnelResult } from "@/lib/synthesis/metrics/funnel";
import { type GeographyResult, runGeography } from "@/lib/synthesis/metrics/geography";
import { runStepFlow, type StepFlowResult } from "@/lib/synthesis/metrics/step-flow";
import { clausesOf, withClause } from "@/lib/synthesis/traces/trace-filter-clauses";
import { type TraceFilter, traceFilterCondition } from "@/lib/synthesis/traces/trace-filters";

export type MetricsDb = Pick<ReturnType<typeof getDb>, "execute">;

/** Why a query is refused. */
export class QueryError extends Error {
  override name = "QueryError";
}

export interface MetricGroupValue {
  value: string;
  /** The value as people read it, when it is an id. */
  label?: string;
}

export interface MetricSeries {
  /** One value per dimension, in the query's order. Empty without dimensions. */
  groups: MetricGroupValue[];
  /** The whole window's value: never the sum of `values`, which a percentile does not allow. */
  total: number | null;
  /** Rows behind `total`: traces, or captured prompts. */
  samples: number;
  /** One value per bucket. Null where a rate, average or percentile has nothing to read. */
  values: (number | null)[];
}

export interface MetricResult {
  kind: "metric";
  bucket: Bucket;
  /** Bucket starts, ISO 8601 in UTC, oldest first. */
  buckets: string[];
  /** One series ungrouped. Grouped: at most `METRIC_GROUP_LIMIT`, highest total first. */
  series: MetricSeries[];
}

export type QueryResult =
  | MetricResult
  | FlowResult
  | StepFlowResult
  | FunnelResult
  | ClustersResult
  | GeographyResult;
/** What a query of one kind answers. */
export type ResultOf<Q extends Query> = Extract<QueryResult, { kind: Q["kind"] }>;

/** A dimension is a column, or an array whose every value counts the row once. */
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
  measures: Partial<Record<MeasureId, { value: SQL; where?: SQL }>>;
  groups: Partial<Record<Dimension, MetricGroup>>;
}

type Row = {
  grp: string[];
  labels: (string | null)[];
  bucket: string | null;
  value: number | string | null;
  samples: number | string;
};

const STEP_MS: Record<Bucket, number> = { hour: 3_600_000, day: 86_400_000 };

const TRACE_TOKENS = sql`s.input_tokens + s.output_tokens`;
const CONTEXT_TOKENS = sql.join(
  CONTEXT_SOURCES.map((source) => sql`coalesce((s.tokens_by_category ->> ${source})::numeric, 0)`),
  sql` + `,
);

const AGGREGATES: Record<Aggregation, SQL> = {
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
} as const satisfies Partial<Record<Dimension, MetricGroup>>;

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

type Runner<K extends Query["kind"]> = (
  projectId: string,
  query: Extract<Query, { kind: K }>,
  scope: QueryScope,
  db: MetricsDb,
) => Promise<Extract<QueryResult, { kind: K }>>;

/**
 * What a higher layer owns. Empty until that module fills it: the scorers
 * (`views/scorers/metrics`) fill `scores` and `funnel`, `views/dashboards/clusters` fills `clusters`.
 */
export const metricSeams: {
  scores?: MetricSourceQuery;
  funnel?: Runner<"funnel">;
  clusters?: Runner<"clusters">;
} = {};

/**
 * The one way a query object runs: over a window, filtered and grouped. Throws
 * `QueryError` for a query the contract does not allow.
 */
export async function runQuery<Q extends Query>(
  projectId: string,
  query: Q,
  scope: QueryScope,
  db: MetricsDb = getDb(),
): Promise<ResultOf<Q>> {
  return (await runParsed(projectId, checkedQuery(query, scope), scope, db)) as ResultOf<Q>;
}

function runParsed(
  projectId: string,
  query: Query,
  scope: QueryScope,
  db: MetricsDb,
): Promise<QueryResult> {
  switch (query.kind) {
    case "metric":
      return runMetric(projectId, query, scope, db);
    case "flow":
      return runFlow(projectId, query, scope, db);
    case "step_flow":
      return runStepFlow(projectId, query, scope, db);
    case "funnel":
      return seam("funnel")(projectId, query, scope, db);
    case "clusters":
      return seam("clusters")(projectId, query, scope, db);
    case "geography":
      return runGeography(projectId, query, scope, db);
  }
}

function seam<K extends "funnel" | "clusters">(kind: K): NonNullable<(typeof metricSeams)[K]> {
  const run = metricSeams[kind];
  // The contract allowed the query, so a hole here is a module that was not loaded.
  if (!run) throw new Error(`no module runs a "${kind}" query`);
  return run;
}

/** A stored query is checked again: the contract may have moved since. */
function checkedQuery(raw: Query, window: QueryWindow): Query {
  const parsed = parseQuery(raw);
  if (!parsed.ok) throw new QueryError(parsed.error);
  const span = window.until.getTime() - window.since.getTime();
  if (!(span > 0)) throw new QueryError("The window is empty.");
  if (span > MAX_METRIC_WINDOW_DAYS * STEP_MS.day)
    throw new QueryError(`The window is longer than ${MAX_METRIC_WINDOW_DAYS} days.`);
  return parsed.query;
}

async function runMetric(
  projectId: string,
  query: MetricQuery,
  scope: QueryScope,
  db: MetricsDb,
): Promise<MetricResult> {
  const [{ measure, aggregation }] = query.measures;
  const metric = getMetric(measure) as MetricDefinition;
  const bucket = query.bucket ?? metricBucket(metric, scope);
  const rows = rowsOf<Row>(
    await db.execute(metricSql(projectId, { query, metric, aggregation, bucket }, scope)),
  );
  const buckets = bucketStarts(scope, bucket);
  return {
    kind: "metric",
    bucket,
    buckets,
    series: toSeries(rows, buckets, aggregation, query.dimensions.length > 0),
  };
}

interface CheckedQuery {
  query: MetricQuery;
  metric: MetricDefinition;
  aggregation: Aggregation;
  bucket: Bucket;
}

/** One value per group over the whole window, highest first: a dimension that is no choice of a person. */
export async function measureBy(
  projectId: string,
  query: Pick<MetricQuery, "measures" | "filters">,
  by: { group: MetricGroup; where: SQL; limit: number },
  scope: QueryScope,
  db: MetricsDb,
): Promise<{ group: string; value: number | null; samples: number }[]> {
  const [{ measure, aggregation }] = query.measures;
  const metric = getMetric(measure) as MetricDefinition;
  const rows = rowsOf<Row>(
    await db.execute(
      aggregateSql(projectId, { ...query, metric, aggregation }, scope, [by.group], {
        where: by.where,
        limit: by.limit,
      }),
    ),
  );
  return rows.map(({ grp, value, samples }) => ({
    group: grp[0],
    value: value === null ? null : Number(value),
    samples: Number(samples),
  }));
}

/** Per group: one row per bucket and one (`bucket` null) for the window, read in one pass. */
function metricSql(
  projectId: string,
  { query, metric, aggregation, bucket }: CheckedQuery,
  scope: QueryScope,
): SQL {
  const source = sourceOf(metric);
  const groups = query.dimensions.map((dimension) => source?.groups[dimension]);
  return aggregateSql(projectId, { filters: query.filters, metric, aggregation }, scope, groups, {
    bucket,
    limit: METRIC_GROUP_LIMIT,
  });
}

function sourceOf(metric: MetricDefinition): MetricSourceQuery | undefined {
  return metric.source === "scores" ? metricSeams.scores : SOURCES[metric.source];
}

/** A metric by groups. Without a bucket only the window's row of each. */
function aggregateSql(
  projectId: string,
  {
    filters,
    metric,
    aggregation,
  }: Pick<MetricQuery, "filters"> & Pick<CheckedQuery, "metric" | "aggregation">,
  scope: QueryScope,
  by: readonly (MetricGroup | undefined)[],
  { bucket, where, limit }: { bucket?: Bucket; where?: SQL; limit: number },
): SQL {
  const source = sourceOf(metric);
  const measure = source?.measures[metric.id];
  const { scorer, ...ownFilter } = filters;
  // Every clause must match: a value of one property in one does not stand in for another.
  const traceFilter = metric.filterable ? withClause(ownFilter, scope.filter) : {};
  const groups = by.map((group, index) => {
    const unnested = sql.raw(`g${index}`);
    return (
      group && {
        join: group.array
          ? sql`cross join lateral (select distinct v from unnest(${group.column}) v) ${unnested}`
          : sql``,
        value: group.array ? sql`${unnested}.v` : group.column,
        label: group.label ?? sql`null::text`,
        only: clausesOf(traceFilter).map((clause) => group.filtered?.(clause) ?? []),
      }
    );
  });
  // The contract allowed the query, so a hole here is a module that was not loaded.
  if (!source || !measure || !groups.every((group) => group !== undefined)) {
    throw new Error(`the metric source "${metric.source}" cannot answer "${metric.id}"`);
  }
  const { table, time } = source;
  const condition = traceFilterCondition(traceFilter);
  return sql`
    with measured as (
      select ${textArray(groups.map(({ value }) => value))} as grp,
        ${textArray(groups.map(({ label }) => label))} as labels,
        ${
          bucket
            ? sql`to_char(date_trunc(${sql.raw(`'${bucket}'`)}, ${time} at time zone 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS".000Z"')`
            : sql`null::text`
        } as bucket,
        ${measure.value} as m
      from ${table} ${sql.join(
        groups.map(({ join }) => join),
        sql` `,
      )}
      where ${source.project} = ${projectId}
        and ${time} >= ${scope.since.toISOString()}::timestamptz
        and ${time} < ${scope.until.toISOString()}::timestamptz
        ${measure.where ? sql`and ${measure.where}` : sql``}
        ${where ? sql`and ${where}` : sql``}
        ${scorer && source.scorer ? sql`and ${source.scorer} = ${scorer.id}::uuid` : sql``}
        ${condition ? sql`and ${condition}` : sql``}
        ${sql.join(
          groups.flatMap(({ value, only }) => [
            sql` and ${value} is not null`,
            ...only
              .filter((names) => names.length > 0)
              .map(
                (names) =>
                  sql` and ${value} = any(${textArray(names.map((name) => sql`${name.trim()}`))})`,
              ),
          ]),
        )}
    ),
    aggregated as (
      select grp, bucket, max(labels) as labels, (${AGGREGATES[aggregation]})::float8 as value, count(*)::int as samples
      from measured
      group by ${bucket ? sql`grouping sets ((grp, bucket), (grp))` : sql`grp, bucket`}
    ),
    top as (
      select grp, row_number() over (order by value desc nulls last, grp collate "C") as rank
      from aggregated where bucket is null
    )
    select a.grp, a.labels, a.bucket, a.value, a.samples
    from aggregated a join top t on t.grp = a.grp
    where t.rank <= ${limit}
    order by t.rank, a.bucket nulls first`;
}

export function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? result) as T[];
}

function textArray(items: readonly SQL[]): SQL {
  return sql`array[${sql.join([...items], sql`, `)}]::text[]`;
}

function toSeries(
  rows: Row[],
  buckets: string[],
  aggregation: Aggregation,
  grouped: boolean,
): MetricSeries[] {
  // Nothing happened is 0 for an amount, and no answer for a ratio.
  const nothing = aggregation === "count" || aggregation === "sum" ? 0 : null;
  const indexOf = new Map(buckets.map((start, index) => [start, index]));
  const byGroup = new Map<string, MetricSeries>();
  const seriesOf = (grp: readonly string[], labels: readonly (string | null)[]) => {
    const key = JSON.stringify(grp);
    let series = byGroup.get(key);
    if (!series) {
      series = {
        groups: grp.map((value, index) => {
          const label = labels[index];
          return label ? { value, label } : { value };
        }),
        total: nothing,
        samples: 0,
        values: buckets.map(() => nothing),
      };
      byGroup.set(key, series);
    }
    return series;
  };
  if (!grouped) seriesOf([], []);
  for (const row of rows) {
    const series = seriesOf(row.grp, row.labels);
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

/** Two values of one name are told apart by the start of their id. */
function withDistinctLabels(series: MetricSeries[]): MetricSeries[] {
  const valuesOf = new Map<string, Set<string>>();
  for (const { value, label } of series.flatMap(({ groups }) => groups))
    if (label) valuesOf.set(label, (valuesOf.get(label) ?? new Set()).add(value));
  return series.map((item) => ({
    ...item,
    groups: item.groups.map((group) =>
      group.label && (valuesOf.get(group.label)?.size ?? 0) > 1
        ? { ...group, label: `${group.label} (${group.value.slice(0, 8)})` }
        : group,
    ),
  }));
}

/** Every bucket the window touches, so a gap in the data is a gap in the series. */
function bucketStarts({ since, until }: QueryWindow, bucket: Bucket): string[] {
  const step = STEP_MS[bucket];
  const starts: string[] = [];
  for (let at = Math.floor(since.getTime() / step) * step; at < until.getTime(); at += step) {
    starts.push(new Date(at).toISOString());
  }
  return starts;
}
