import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notExists,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { alias, unionAll } from "drizzle-orm/pg-core";
import { events, type OtelSpan, otelLogs, otelSpans } from "@/lib/ingest/otlp/schema";
import { getDb } from "@/lib/platform/db/client";
import { otelTraceSummaries } from "@/lib/synthesis/traces/schema";
import { containsText } from "./query-text";

export type TraceQueriesDb = Pick<ReturnType<typeof getDb>, "select" | "selectDistinctOn">;

export type TraceMaintenanceDb = Pick<ReturnType<typeof getDb>, "delete" | "select">;

export interface PruneExpiredOtelSpansOptions {
  now?: Date;
  retentionDays?: number;
}

export interface PruneExpiredOtelLogsOptions {
  now?: Date;
  retentionDays?: number;
}

export interface PruneExpiredTraceSummariesOptions {
  now?: Date;
  retentionDays?: number;
}

export interface TraceCursor {
  startedAt: Date;
  traceId: string;
  sortValue?: number;
}

export type SpanScope = "all" | "root";

export interface SpanCursor {
  startedAt: Date;
  id: string;
  sortValue?: number;
}

export interface ListSpansOptions extends TraceFacetFilters {
  since?: Date;
  until?: Date;
  scope?: SpanScope;
  name?: string;
  model?: string;
  tool?: string;
  experiment?: string;
  /** Experiment arm. The span filter builder already honours this; it was simply
   * never declared here, so the view layer had no way to pass it through. */
  arm?: string;
  errorOnly?: boolean;
  sort?: RecordSort;
  direction?: SortDirection;
  cursor?: SpanCursor;
  limit?: number;
}

export type TraceFacetKey =
  | "service"
  | "name"
  | "status"
  | "kind"
  | "environment"
  | "model"
  | "tool"
  | "experiment"
  | "arm";

export interface TraceFacetFilters {
  services?: readonly string[];
  names?: readonly string[];
  statuses?: readonly number[];
  kinds?: readonly number[];
  environments?: readonly string[];
  models?: readonly string[];
  experiments?: readonly string[];
  arms?: readonly string[];
  minDurationMs?: number;
  maxDurationMs?: number;
  minTokens?: number;
  maxTokens?: number;
  minCostUsd?: number;
  maxCostUsd?: number;
}

export interface TraceFacetOptions extends TraceFacetFilters {
  since?: Date;
  until?: Date;
  scope?: SpanScope;
  name?: string;
  model?: string;
  tool?: string;
  experiment?: string;
  arm?: string;
  errorOnly?: boolean;
}

export interface TraceFacetValue {
  value: string;
  count: number;
}

export type TraceFacets = Record<TraceFacetKey, TraceFacetValue[]>;

type TraceFacetDimension = readonly [TraceFacetKey, SQL<string>];

interface TraceFacetCountRow {
  facet: TraceFacetKey;
  value: string | null;
  count: number;
}

export interface TraceAggregateVolume {
  day: string;
  /** UTC hour of `day` (0 to 23), present only when hourly volume was asked for. */
  hour?: number;
  count: number;
  errorCount: number;
}

/** Volume granularity for {@link getTraceAggregates}; daily unless asked otherwise. */
export interface TraceVolumeOptions {
  volumeBucket?: "day" | "hour";
}

export interface TraceAggregateSummary {
  count: number;
  errorCount: number;
  errorRate: number;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  p99DurationMs: number | null;
  costUsd: number;
  totalTokens: number;
  volume: TraceAggregateVolume[];
}

export interface SpanSummary {
  id: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: number;
  spanClass: string;
  startedAt: Date;
  durationMs: number;
  statusCode: number;
  serviceName: string | null;
  operationName: string | null;
  model: string | null;
  toolName: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  experimentName: string | null;
}

export interface SpanPage {
  items: SpanSummary[];
  hasMore: boolean;
  nextCursor: SpanCursor | null;
}

export type OperationGroupBy = "name" | "model" | "tool";
export type RecordSort = "started" | "duration" | "tokens" | "cost";
export type OperationSort =
  | "key"
  | "count"
  | "errorRate"
  | "p50"
  | "p95"
  | "p99"
  | "cost"
  | "tokens";
export type SortDirection = "asc" | "desc";

export interface ListOperationsOptions extends TraceFacetFilters {
  since?: Date;
  until?: Date;
  groupBy?: OperationGroupBy;
  sort?: OperationSort;
  direction?: SortDirection;
  name?: string;
  model?: string;
  tool?: string;
  experiment?: string;
  /** Variant (arm) substring, as the span list filters it. */
  arm?: string;
  /** `root` groups top-level spans only, as the span list does. */
  scope?: SpanScope;
  errorOnly?: boolean;
}

export interface OperationAggregate {
  key: string;
  count: number;
  errorCount: number;
  errorRate: number;
  p50DurationMs: number;
  p95DurationMs: number;
  p99DurationMs: number;
  costUsd: number;
  totalTokens: number;
}

export interface ListTracesOptions extends TraceFacetFilters {
  since?: Date;
  until?: Date;
  rootName?: string;
  spanName?: string;
  model?: string;
  tool?: string;
  errorOnly?: boolean;
  experiment?: string;
  arm?: string;
  sort?: RecordSort;
  direction?: SortDirection;
  cursor?: TraceCursor;
  limit?: number;
}

export interface TraceSummary {
  traceId: string;
  rootSpanId: string;
  rootName: string;
  startedAt: Date;
  endedAt: Date;
  durationMs: number;
  statusCode: number;
  serviceName: string | null;
  spanCount: number;
  errorCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  experimentName: string | null;
  experimentArm: string | null;
}

export interface TracePage {
  items: TraceSummary[];
  hasMore: boolean;
  nextCursor: TraceCursor | null;
}

export interface TraceSpanLoad {
  spans: OtelSpan[];
  truncated: boolean;
}

export interface TraceLifecycleEvent {
  id: string;
  eventName: string;
  occurredAt: Date;
  spanId: string | null;
  experimentName: string | null;
  experimentArm: string | null;
  experimentRole: string | null;
  experimentSelectionId: string | null;
  experimentAttrs: Record<string, unknown>;
}

export interface TraceWindow {
  since: Date;
  until: Date;
}

export interface TraceKpis {
  traceCount: number;
  errorTraceCount: number;
  errorRate: number;
  averageLatencyMs: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface TraceDailyAggregate {
  day: string;
  traceCount: number;
  errorTraceCount: number;
  averageLatencyMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

/** The raw aggregate row both KPI reads produce, before shaping. */
interface TraceKpiRow {
  traceCount: number;
  errorTraceCount: number;
  averageLatencyMs: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: string;
}

type TraceDailyRow = Omit<TraceDailyAggregate, "totalTokens" | "costUsd"> & {
  costUsd: string;
};

export interface TracesIngestDiagnostics {
  hasEvents: boolean;
  hasSpans: boolean;
  latestEventAt: Date | null;
  latestSpanAt: Date | null;
}

/** Zeroed KPIs surfaced when the KPI aggregate is unavailable, so the trace
 * list still renders. `traceCount === 0` hides the KPI band and volume chart. */
export const EMPTY_TRACE_KPIS: TraceKpis = {
  traceCount: 0,
  errorTraceCount: 0,
  errorRate: 0,
  averageLatencyMs: null,
  p50LatencyMs: null,
  p95LatencyMs: null,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  costUsd: 0,
};

export const EMPTY_TRACE_FACETS: TraceFacets = {
  service: [],
  name: [],
  status: [],
  kind: [],
  environment: [],
  model: [],
  tool: [],
  experiment: [],
  arm: [],
};

export const EMPTY_TRACE_AGGREGATE: TraceAggregateSummary = {
  count: 0,
  errorCount: 0,
  errorRate: 0,
  p50DurationMs: null,
  p95DurationMs: null,
  p99DurationMs: null,
  costUsd: 0,
  totalTokens: 0,
  volume: [],
};

export const TRACE_SPAN_LIMIT = 5_000;
export const DEFAULT_TRACE_PAGE_SIZE = 50;
export const MAX_TRACE_PAGE_SIZE = 100;
export const DEFAULT_SPAN_PAGE_SIZE = 50;
export const MAX_SPAN_PAGE_SIZE = 100;
export const TRACE_FACET_VALUE_LIMIT = 50;
export const OPERATION_AGGREGATE_LIMIT = 200;
export const DEFAULT_OTEL_SPAN_RETENTION_DAYS = 30;
export const OTEL_SPAN_PRUNE_BATCH_SIZE = 5_000;
export const OTEL_LOG_PRUNE_BATCH_SIZE = 5_000;
export const TRACE_SUMMARY_PRUNE_BATCH_SIZE = 5_000;
const TRACE_LIFECYCLE_EVENT_NAMES = [
  "ratel.experiment.results",
  "ratel.experiment.comparison",
  "ratel.experiment.skip",
  "ratel.experiment.fallback",
  "ratel.experiment.drop",
  "ratel.experiment.outcome",
] as const;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;
const MAX_SAFE_RETENTION_DAYS = 100_000_000;

/**
 * List project-scoped traces from representative root spans, then aggregate the
 * selected traces in a second query. Keeping pagination on roots avoids slicing
 * a trace merely because it contains many spans.
 *
 * Representatives are chosen among IN-WINDOW spans only (earliest in-window
 * root, or the earliest in-window span of a trace with no root at all), so both
 * branches stay on the partial roots / started_at indexes instead of ranking
 * every span the project has ever retained. For a malformed trace straddling
 * the window boundary this surfaces the earliest in-window span rather than
 * hiding the trace because its overall-earliest span precedes the window.
 */
export async function listTraces(
  projectId: string,
  options: ListTracesOptions = {},
  db: TraceQueriesDb = getDb(),
): Promise<TracePage> {
  const limit = pageSize(options.limit);
  const { dimensionTraceIds, errorTraceIds, experimentTraceIds, facetTraceIds } =
    traceMembershipSubqueries(projectId, options, db);
  const representativeColumns = {
    traceId: otelSpans.traceId,
    rootSpanId: otelSpans.spanId,
    rootName: otelSpans.name,
    startedAt: otelSpans.startedAt,
    endedAt: otelSpans.endedAt,
    durationMs: otelSpans.durationMs,
    statusCode: otelSpans.statusCode,
    serviceName: otelSpans.serviceName,
    experimentName: otelSpans.experimentName,
    experimentArm: otelSpans.experimentArm,
  };
  const windowBounds = and(
    options.since ? gte(otelSpans.startedAt, options.since) : undefined,
    options.until ? lt(otelSpans.startedAt, options.until) : undefined,
  );
  // Earliest in-window true root per trace — an index-only walk of the partial
  // roots index, never a scan of the full span corpus.
  const rootedTraces = db
    .selectDistinctOn([otelSpans.traceId], representativeColumns)
    .from(otelSpans)
    .where(and(eq(otelSpans.projectId, projectId), isNull(otelSpans.parentSpanId), windowBounds))
    .orderBy(asc(otelSpans.traceId), asc(otelSpans.startedAt), asc(otelSpans.spanId));
  // Traces with no root span anywhere (malformed exports): promote their
  // earliest in-window span. Every step here is bounded by the window — an
  // index-only walk of the covering (project, started_at, trace_id) index
  // minus in-window roots leaves a tiny candidate set, and only those few
  // candidates pay the "has a root anywhere?" probe, which also keeps a trace
  // whose root simply fell outside the window excluded (like the rooted
  // branch). Cost stays O(in-window spans), never O(retained spans).
  const inWindowRootTraceIds = db
    .select({ traceId: otelSpans.traceId })
    .from(otelSpans)
    .where(and(eq(otelSpans.projectId, projectId), isNull(otelSpans.parentSpanId), windowBounds))
    .groupBy(otelSpans.traceId);
  const inWindowRootless = db
    .select({ traceId: otelSpans.traceId })
    .from(otelSpans)
    .where(and(eq(otelSpans.projectId, projectId), windowBounds))
    .groupBy(otelSpans.traceId)
    .having(notInArray(otelSpans.traceId, inWindowRootTraceIds))
    .as("in_window_rootless");
  const rootProbe = alias(otelSpans, "root_probe");
  const rootlessCandidates = db
    .select({ traceId: inWindowRootless.traceId })
    .from(inWindowRootless)
    .where(
      notExists(
        db
          .select({ present: sql`1` })
          .from(rootProbe)
          .where(
            and(
              eq(rootProbe.projectId, projectId),
              eq(rootProbe.traceId, inWindowRootless.traceId),
              isNull(rootProbe.parentSpanId),
            ),
          ),
      ),
    )
    .as("rootless_candidates");
  const rootlessRepresentative = db
    .select(representativeColumns)
    .from(otelSpans)
    .where(
      and(
        eq(otelSpans.projectId, projectId),
        windowBounds,
        eq(otelSpans.traceId, rootlessCandidates.traceId),
      ),
    )
    .orderBy(asc(otelSpans.startedAt), asc(otelSpans.spanId))
    .limit(1)
    .as("rootless_representative");
  const rootlessTraces = db
    .select({
      traceId: rootlessRepresentative.traceId,
      rootSpanId: rootlessRepresentative.rootSpanId,
      rootName: rootlessRepresentative.rootName,
      startedAt: rootlessRepresentative.startedAt,
      endedAt: rootlessRepresentative.endedAt,
      durationMs: rootlessRepresentative.durationMs,
      statusCode: rootlessRepresentative.statusCode,
      serviceName: rootlessRepresentative.serviceName,
      experimentName: rootlessRepresentative.experimentName,
      experimentArm: rootlessRepresentative.experimentArm,
    })
    .from(rootlessCandidates)
    .crossJoinLateral(rootlessRepresentative);
  const representatives = unionAll(rootedTraces, rootlessTraces).as("trace_representatives");
  const rootColumns = {
    traceId: representatives.traceId,
    rootSpanId: representatives.rootSpanId,
    rootName: representatives.rootName,
    startedAt: representatives.startedAt,
    endedAt: representatives.endedAt,
    durationMs: representatives.durationMs,
    statusCode: representatives.statusCode,
    serviceName: representatives.serviceName,
    experimentName: representatives.experimentName,
    experimentArm: representatives.experimentArm,
  };
  const sort = options.sort ?? "started";
  const direction = options.direction ?? "desc";
  const order = direction === "asc" ? asc : desc;
  const before = direction === "asc" ? gt : lt;
  const rootFilter = and(
    options.rootName !== undefined
      ? containsText(representatives.rootName, options.rootName)
      : undefined,
    errorTraceIds ? inArray(representatives.traceId, errorTraceIds) : undefined,
    experimentTraceIds ? inArray(representatives.traceId, experimentTraceIds) : undefined,
    dimensionTraceIds ? inArray(representatives.traceId, dimensionTraceIds) : undefined,
    facetTraceIds ? inArray(representatives.traceId, facetTraceIds) : undefined,
  );
  const roots =
    sort === "tokens" || sort === "cost"
      ? await (() => {
          const traceTotals = db
            .select({
              traceId: otelSpans.traceId,
              totalTokens:
                sql<number>`coalesce(sum(coalesce(${otelSpans.inputTokens}, 0) + coalesce(${otelSpans.outputTokens}, 0)), 0)::float8`.as(
                  "total_tokens",
                ),
              costUsd: sql<number>`coalesce(sum(${otelSpans.costUsd}), 0)::float8`.as("cost_usd"),
            })
            .from(otelSpans)
            .where(and(eq(otelSpans.projectId, projectId), windowBounds))
            .groupBy(otelSpans.traceId)
            .as("trace_totals");
          const metricSort = sort === "tokens" ? traceTotals.totalTokens : traceTotals.costUsd;
          const metricSortExpression = sql<number>`${metricSort}`;
          const cursorFilter = options.cursor
            ? options.cursor.sortValue === undefined
              ? sql`false`
              : or(
                  before(metricSortExpression, options.cursor.sortValue),
                  and(
                    eq(metricSortExpression, options.cursor.sortValue),
                    before(representatives.traceId, options.cursor.traceId),
                  ),
                )
            : undefined;
          return db
            .select(rootColumns)
            .from(representatives)
            .innerJoin(traceTotals, eq(traceTotals.traceId, representatives.traceId))
            .where(and(rootFilter, cursorFilter))
            .orderBy(order(metricSortExpression), order(representatives.traceId))
            .limit(limit + 1);
        })()
      : await (() => {
          const recordSort =
            sort === "started" ? representatives.startedAt : representatives.durationMs;
          const cursorFilter = options.cursor
            ? sort === "started"
              ? or(
                  before(recordSort, options.cursor.startedAt),
                  and(
                    eq(recordSort, options.cursor.startedAt),
                    before(representatives.traceId, options.cursor.traceId),
                  ),
                )
              : options.cursor.sortValue === undefined
                ? sql`false`
                : or(
                    before(recordSort, options.cursor.sortValue),
                    and(
                      eq(recordSort, options.cursor.sortValue),
                      before(representatives.traceId, options.cursor.traceId),
                    ),
                  )
            : undefined;
          return db
            .select(rootColumns)
            .from(representatives)
            .where(and(rootFilter, cursorFilter))
            .orderBy(order(recordSort), order(representatives.traceId))
            .limit(limit + 1);
        })();
  const hasMore = roots.length > limit;
  const pageRoots = roots.slice(0, limit);
  if (pageRoots.length === 0) {
    return { items: [], hasMore: false, nextCursor: null };
  }
  const pageTraceIds = pageRoots.map(({ traceId }) => traceId);
  const activeExperimentPairFilter = and(
    options.experiment !== undefined
      ? containsText(otelSpans.experimentName, options.experiment)
      : undefined,
    options.arm !== undefined ? containsText(otelSpans.experimentArm, options.arm) : undefined,
  );
  const experimentPairPriority =
    activeExperimentPairFilter === undefined
      ? sql<number>`0`
      : sql<number>`case when ${activeExperimentPairFilter} then 0 else 1 end`;
  const rankedExperimentPairs = db
    .select({
      traceId: otelSpans.traceId,
      experimentName: otelSpans.experimentName,
      experimentArm: otelSpans.experimentArm,
      pairRank:
        sql<number>`(row_number() over (partition by ${otelSpans.traceId} order by ${experimentPairPriority}, case when ${otelSpans.parentSpanId} is null then 0 else 1 end, ${otelSpans.startedAt}, ${otelSpans.spanId}))::int`.as(
          "pair_rank",
        ),
    })
    .from(otelSpans)
    .where(
      and(
        eq(otelSpans.projectId, projectId),
        inArray(otelSpans.traceId, pageTraceIds),
        or(isNotNull(otelSpans.experimentName), isNotNull(otelSpans.experimentArm)),
      ),
    )
    .as("ranked_experiment_pairs");

  // Deliberate mixed scoping: `spanCount`/`errorCount` describe the *structure*
  // of the whole trace (a trace is one unit however its spans straddle the
  // window), while the token/cost totals are window-bound so the tokens/cost
  // sort ranks pages by in-window activity rather than lifetime totals.
  const aggregates = await db
    .select({
      traceId: otelSpans.traceId,
      spanCount: sql<number>`count(*)::int`,
      errorCount: sql<number>`count(*) filter (where ${otelSpans.statusCode} = 2)::int`,
      inputTokens: windowBounds
        ? sql<number>`coalesce(sum(${otelSpans.inputTokens}) filter (where ${windowBounds}), 0)::float8`
        : sql<number>`coalesce(sum(${otelSpans.inputTokens}), 0)::float8`,
      outputTokens: windowBounds
        ? sql<number>`coalesce(sum(${otelSpans.outputTokens}) filter (where ${windowBounds}), 0)::float8`
        : sql<number>`coalesce(sum(${otelSpans.outputTokens}), 0)::float8`,
      costUsd: windowBounds
        ? sql<string>`coalesce(sum(${otelSpans.costUsd}) filter (where ${windowBounds}), 0)::text`
        : sql<string>`coalesce(sum(${otelSpans.costUsd}), 0)::text`,
      experimentName: rankedExperimentPairs.experimentName,
      experimentArm: rankedExperimentPairs.experimentArm,
    })
    .from(otelSpans)
    .leftJoin(
      rankedExperimentPairs,
      and(
        eq(rankedExperimentPairs.traceId, otelSpans.traceId),
        eq(rankedExperimentPairs.pairRank, 1),
      ),
    )
    .where(and(eq(otelSpans.projectId, projectId), inArray(otelSpans.traceId, pageTraceIds)))
    .groupBy(
      otelSpans.traceId,
      rankedExperimentPairs.experimentName,
      rankedExperimentPairs.experimentArm,
    );
  const aggregateByTrace = new Map(aggregates.map((aggregate) => [aggregate.traceId, aggregate]));
  const items = pageRoots.map((root): TraceSummary => {
    const aggregate = aggregateByTrace.get(root.traceId);
    const inputTokens = aggregate?.inputTokens ?? 0;
    const outputTokens = aggregate?.outputTokens ?? 0;
    return {
      ...root,
      spanCount: aggregate?.spanCount ?? 0,
      errorCount: aggregate?.errorCount ?? 0,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      costUsd: Number(aggregate?.costUsd ?? 0),
      experimentName: aggregate?.experimentName ?? null,
      experimentArm: aggregate?.experimentArm ?? null,
    };
  });
  const last = items.at(-1);

  return {
    items,
    hasMore,
    nextCursor:
      hasMore && last
        ? {
            startedAt: last.startedAt,
            traceId: last.traceId,
            ...(sort === "started"
              ? {}
              : {
                  sortValue:
                    sort === "duration"
                      ? last.durationMs
                      : sort === "tokens"
                        ? last.totalTokens
                        : last.costUsd,
                }),
          }
        : null,
  };
}

/** List individual project spans in a stable newest-first cursor frame. */
export async function listSpans(
  projectId: string,
  options: ListSpansOptions = {},
  db: TraceQueriesDb = getDb(),
): Promise<SpanPage> {
  const limit = spanPageSize(options.limit);
  const toolName = sql<string | null>`${otelSpans.attributes} ->> 'gen_ai.tool.name'`;
  const sort = options.sort ?? "started";
  const direction = options.direction ?? "desc";
  const order = direction === "asc" ? asc : desc;
  const before = direction === "asc" ? gt : lt;
  const totalTokens = sql<number>`coalesce(${otelSpans.inputTokens}, 0) + coalesce(${otelSpans.outputTokens}, 0)`;
  const costUsd = sql<number>`coalesce(${otelSpans.costUsd}, 0)::float8`;
  const metricSort =
    sort === "duration" ? otelSpans.durationMs : sort === "tokens" ? totalTokens : costUsd;
  const metricSortExpression = sql<number>`${metricSort}`;
  const cursorFilter = options.cursor
    ? sort === "started"
      ? or(
          before(otelSpans.startedAt, options.cursor.startedAt),
          and(
            eq(otelSpans.startedAt, options.cursor.startedAt),
            before(otelSpans.id, options.cursor.id),
          ),
        )
      : options.cursor.sortValue === undefined
        ? sql`false`
        : or(
            before(metricSortExpression, options.cursor.sortValue),
            and(
              eq(metricSortExpression, options.cursor.sortValue),
              before(otelSpans.id, options.cursor.id),
            ),
          )
    : undefined;
  const rows = await db
    .select({
      id: otelSpans.id,
      traceId: otelSpans.traceId,
      spanId: otelSpans.spanId,
      parentSpanId: otelSpans.parentSpanId,
      name: otelSpans.name,
      kind: otelSpans.kind,
      spanClass: otelSpans.spanClass,
      startedAt: otelSpans.startedAt,
      durationMs: otelSpans.durationMs,
      statusCode: otelSpans.statusCode,
      serviceName: otelSpans.serviceName,
      operationName: otelSpans.operationName,
      model: otelSpans.model,
      toolName,
      inputTokens: otelSpans.inputTokens,
      outputTokens: otelSpans.outputTokens,
      costUsd: otelSpans.costUsd,
      experimentName: otelSpans.experimentName,
    })
    .from(otelSpans)
    .where(and(eq(otelSpans.projectId, projectId), spanFacetFilter(options), cursorFilter))
    .orderBy(
      order(sort === "started" ? otelSpans.startedAt : metricSortExpression),
      order(otelSpans.id),
    )
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map((row): SpanSummary => {
    const inputTokens = row.inputTokens ?? 0;
    const outputTokens = row.outputTokens ?? 0;
    return {
      ...row,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      costUsd: Number(row.costUsd ?? 0),
    };
  });
  const last = items.at(-1);

  return {
    items,
    hasMore,
    nextCursor:
      hasMore && last
        ? {
            startedAt: last.startedAt,
            id: last.id,
            ...(sort === "started"
              ? {}
              : {
                  sortValue:
                    sort === "duration"
                      ? last.durationMs
                      : sort === "tokens"
                        ? last.totalTokens
                        : last.costUsd,
                }),
          }
        : null,
  };
}

/**
 * Count span facets after applying the active filter frame. Each dimension
 * ignores its own checkbox selections so alternatives remain discoverable.
 */
export async function getTraceFacets(
  projectId: string,
  options: TraceFacetOptions = {},
  db: TraceQueriesDb = getDb(),
): Promise<TraceFacets> {
  const environment = sql<string>`coalesce(${otelSpans.attributes} ->> 'deployment.environment.name', ${otelSpans.attributes} ->> 'deployment.environment')`;
  const tool = sql<string>`${otelSpans.attributes} ->> 'gen_ai.tool.name'`;
  const dimensions = [
    ["service", sql<string>`${otelSpans.serviceName}`],
    ["name", sql<string>`${otelSpans.name}`],
    ["status", sql<string>`${otelSpans.statusCode}::text`],
    ["kind", sql<string>`${otelSpans.kind}::text`],
    ["environment", environment],
    ["model", sql<string>`${otelSpans.model}`],
    ["tool", tool],
    ["experiment", sql<string>`${otelSpans.experimentName}`],
    ["arm", sql<string>`${otelSpans.experimentArm}`],
  ] as const satisfies readonly TraceFacetDimension[];
  const selectedDimensions = dimensions.filter(([facet]) => hasActiveFacetFilter(options, facet));
  const sharedDimensions = dimensions.filter(([facet]) => !hasActiveFacetFilter(options, facet));
  const rows = (
    await Promise.all([
      ...(sharedDimensions.length > 0
        ? [countFacetValues(projectId, options, sharedDimensions, db)]
        : []),
      ...selectedDimensions.map((dimension) =>
        countFacetValues(projectId, options, [dimension], db, dimension[0]),
      ),
    ])
  ).flat();
  const facets = structuredClone(EMPTY_TRACE_FACETS);

  for (const row of rows) {
    if (row.value == null || row.value.trim() === "") continue;
    if (facets[row.facet].length >= TRACE_FACET_VALUE_LIMIT) continue;
    facets[row.facet].push({ value: row.value, count: row.count });
  }

  return facets;
}

/** Span-grain totals and UTC-day volume for the active workspace filters. */
export async function getSpanAggregates(
  projectId: string,
  options: TraceFacetOptions = {},
  db: TraceQueriesDb = getDb(),
): Promise<TraceAggregateSummary> {
  const count = sql<number>`count(*)::int`;
  const errorCount = sql<number>`count(*) filter (where ${otelSpans.statusCode} = 2)::int`;
  const totalTokens = sql<number>`coalesce(sum(coalesce(${otelSpans.inputTokens}, 0) + coalesce(${otelSpans.outputTokens}, 0)), 0)::float8`;
  const where = and(eq(otelSpans.projectId, projectId), spanFacetFilter(options));
  const day = sql<string>`to_char(date_trunc('day', ${otelSpans.startedAt} at time zone 'UTC'), 'YYYY-MM-DD')`;
  const [totals, volume] = await Promise.all([
    db
      .select({
        count,
        errorCount,
        p50DurationMs: sql<
          number | null
        >`percentile_cont(0.5) within group (order by ${otelSpans.durationMs})::float8`,
        p95DurationMs: sql<
          number | null
        >`percentile_cont(0.95) within group (order by ${otelSpans.durationMs})::float8`,
        p99DurationMs: sql<
          number | null
        >`percentile_cont(0.99) within group (order by ${otelSpans.durationMs})::float8`,
        costUsd: sql<number>`coalesce(sum(${otelSpans.costUsd}), 0)::float8`,
        totalTokens,
      })
      .from(otelSpans)
      .where(where),
    db.select({ day, count, errorCount }).from(otelSpans).where(where).groupBy(day).orderBy(day),
  ]);
  const row = totals[0];
  const aggregateCount = row?.count ?? 0;
  const aggregateErrors = row?.errorCount ?? 0;

  return {
    count: aggregateCount,
    errorCount: aggregateErrors,
    errorRate: aggregateCount === 0 ? 0 : aggregateErrors / aggregateCount,
    p50DurationMs: row?.p50DurationMs ?? null,
    p95DurationMs: row?.p95DurationMs ?? null,
    p99DurationMs: row?.p99DurationMs ?? null,
    costUsd: row?.costUsd ?? 0,
    totalTokens: row?.totalTokens ?? 0,
    volume,
  };
}

/**
 * Trace-grain totals filtered by root fields and matching child spans. Volume
 * is per UTC day, or per UTC hour of each day with `volumeBucket: "hour"`.
 */
export async function getTraceAggregates(
  projectId: string,
  options: ListTracesOptions & TraceWindow & TraceVolumeOptions,
  db: TraceQueriesDb = getDb(),
): Promise<TraceAggregateSummary> {
  const rollups = traceRollups(projectId, options, db);
  const { dimensionTraceIds, errorTraceIds, experimentTraceIds, facetTraceIds } =
    traceMembershipSubqueries(projectId, options, db);
  const where = and(
    options.rootName ? containsText(rollups.rootName, options.rootName) : undefined,
    dimensionTraceIds ? inArray(rollups.traceId, dimensionTraceIds) : undefined,
    errorTraceIds ? inArray(rollups.traceId, errorTraceIds) : undefined,
    experimentTraceIds ? inArray(rollups.traceId, experimentTraceIds) : undefined,
    facetTraceIds ? inArray(rollups.traceId, facetTraceIds) : undefined,
  );
  const count = sql<number>`count(*)::int`;
  const errorCount = sql<number>`coalesce(sum(${rollups.hasError}), 0)::int`;
  const day = sql<string>`to_char(date_trunc('day', ${rollups.startedAt} at time zone 'UTC'), 'YYYY-MM-DD')`;
  const hour = sql<number>`extract(hour from ${rollups.startedAt} at time zone 'UTC')::int`;
  const [totals, volume] = await Promise.all([
    db
      .select({
        count,
        errorCount,
        p50DurationMs: sql<
          number | null
        >`percentile_cont(0.5) within group (order by ${rollups.durationMs})::float8`,
        p95DurationMs: sql<
          number | null
        >`percentile_cont(0.95) within group (order by ${rollups.durationMs})::float8`,
        p99DurationMs: sql<
          number | null
        >`percentile_cont(0.99) within group (order by ${rollups.durationMs})::float8`,
        costUsd: sql<number>`coalesce(sum(${rollups.costUsd}), 0)::float8`,
        totalTokens: sql<number>`coalesce(sum(${rollups.inputTokens} + ${rollups.outputTokens}), 0)::float8`,
      })
      .from(rollups)
      .where(where),
    options.volumeBucket === "hour"
      ? db
          .select({ day, hour, count, errorCount })
          .from(rollups)
          .where(where)
          .groupBy(day, hour)
          .orderBy(day, hour)
      : db.select({ day, count, errorCount }).from(rollups).where(where).groupBy(day).orderBy(day),
  ]);
  const row = totals[0];
  const aggregateCount = row?.count ?? 0;
  const aggregateErrors = row?.errorCount ?? 0;

  return {
    count: aggregateCount,
    errorCount: aggregateErrors,
    errorRate: aggregateCount === 0 ? 0 : aggregateErrors / aggregateCount,
    p50DurationMs: row?.p50DurationMs ?? null,
    p95DurationMs: row?.p95DurationMs ?? null,
    p99DurationMs: row?.p99DurationMs ?? null,
    costUsd: row?.costUsd ?? 0,
    totalTokens: row?.totalTokens ?? 0,
    volume,
  };
}

/** Aggregate spans by operation, model, or tool with database percentiles. */
export async function listOperations(
  projectId: string,
  options: ListOperationsOptions = {},
  db: TraceQueriesDb = getDb(),
): Promise<OperationAggregate[]> {
  const groupBy = options.groupBy ?? "name";
  const toolName = sql<string | null>`${otelSpans.attributes} ->> 'gen_ai.tool.name'`;
  const groupKey =
    groupBy === "model" ? otelSpans.model : groupBy === "tool" ? toolName : otelSpans.name;
  const count = sql<number>`count(*)::int`;
  const errorCount = sql<number>`count(*) filter (where ${otelSpans.statusCode} = 2)::int`;
  const errorRate = sql<number>`(count(*) filter (where ${otelSpans.statusCode} = 2))::float8 / count(*)`;
  const p50 = sql<number>`percentile_cont(0.5) within group (order by ${otelSpans.durationMs})::float8`;
  const p95 = sql<number>`percentile_cont(0.95) within group (order by ${otelSpans.durationMs})::float8`;
  const p99 = sql<number>`percentile_cont(0.99) within group (order by ${otelSpans.durationMs})::float8`;
  const cost = sql<number>`coalesce(sum(${otelSpans.costUsd}), 0)::float8`;
  const tokens = sql<number>`coalesce(sum(coalesce(${otelSpans.inputTokens}, 0) + coalesce(${otelSpans.outputTokens}, 0)), 0)::float8`;
  const sort = operationSortExpression(options.sort ?? "count", groupKey, {
    count,
    errorRate,
    p50,
    p95,
    p99,
    cost,
    tokens,
  });
  const order = options.direction === "asc" ? asc : desc;
  const rows = await db
    .select({
      key: groupKey,
      count,
      errorCount,
      errorRate,
      p50DurationMs: p50,
      p95DurationMs: p95,
      p99DurationMs: p99,
      costUsd: cost,
      totalTokens: tokens,
    })
    .from(otelSpans)
    .where(
      and(
        eq(otelSpans.projectId, projectId),
        spanFacetFilter(options),
        groupBy === "name" ? undefined : isNotNull(groupKey),
        groupBy === "name" ? undefined : sql`btrim(${groupKey}) <> ''`,
      ),
    )
    .groupBy(groupKey)
    .orderBy(order(sort), asc(groupKey))
    .limit(OPERATION_AGGREGATE_LIMIT);

  return rows.flatMap((row): OperationAggregate[] =>
    row.key === null
      ? []
      : [
          {
            ...row,
            key: row.key,
          },
        ],
  );
}

/**
 * Load one project-scoped trace in deterministic display order.
 *
 * Parent spans normally precede their children because they start first. The
 * span-id tie-break keeps malformed or clock-tied exports stable; tree building
 * remains responsible for hierarchy and orphan handling.
 */
export async function getTraceSpans(
  projectId: string,
  traceId: string,
  db: TraceQueriesDb = getDb(),
): Promise<OtelSpan[]> {
  return (await getTraceSpansWithTruncation(projectId, traceId, db)).spans;
}

export async function getTraceSpansWithTruncation(
  projectId: string,
  traceId: string,
  db: TraceQueriesDb = getDb(),
): Promise<TraceSpanLoad> {
  const rows = await db
    .select()
    .from(otelSpans)
    .where(and(eq(otelSpans.projectId, projectId), eq(otelSpans.traceId, traceId)))
    .orderBy(asc(otelSpans.startedAt), asc(otelSpans.spanId))
    .limit(TRACE_SPAN_LIMIT + 1);

  return {
    spans: rows.slice(0, TRACE_SPAN_LIMIT),
    truncated: rows.length > TRACE_SPAN_LIMIT,
  };
}

/** List arm-anchored experiment events for one project-scoped trace. */
export async function listTraceLifecycleEvents(
  projectId: string,
  traceId: string,
  db: TraceQueriesDb = getDb(),
): Promise<TraceLifecycleEvent[]> {
  return db
    .select({
      id: otelLogs.id,
      eventName: otelLogs.eventName,
      occurredAt: otelLogs.occurredAt,
      spanId: otelLogs.spanId,
      experimentName: otelLogs.experimentName,
      experimentArm: otelLogs.experimentArm,
      experimentRole: otelLogs.experimentRole,
      experimentSelectionId: otelLogs.experimentSelectionId,
      experimentAttrs: otelLogs.experimentAttrs,
    })
    .from(otelLogs)
    .where(
      and(
        eq(otelLogs.projectId, projectId),
        eq(otelLogs.traceId, traceId),
        inArray(otelLogs.eventName, [...TRACE_LIFECYCLE_EVENT_NAMES]),
      ),
    )
    .orderBy(asc(otelLogs.occurredAt), asc(otelLogs.id));
}

/** Aggregate trace-level KPIs without weighting traces by their span counts. */
export async function getTraceKpis(
  projectId: string,
  window: TraceWindow,
  db: TraceQueriesDb = getDb(),
): Promise<TraceKpis> {
  const rollups = traceRollups(projectId, window, db);
  const [row] = await db
    .select({
      traceCount: sql<number>`count(*)::int`,
      errorTraceCount: sql<number>`coalesce(sum(${rollups.hasError}), 0)::int`,
      averageLatencyMs: sql<number | null>`avg(${rollups.durationMs})::float8`,
      p50LatencyMs: sql<
        number | null
      >`percentile_cont(0.5) within group (order by ${rollups.durationMs})::float8`,
      p95LatencyMs: sql<
        number | null
      >`percentile_cont(0.95) within group (order by ${rollups.durationMs})::float8`,
      inputTokens: sql<number>`coalesce(sum(${rollups.inputTokens}), 0)::float8`,
      outputTokens: sql<number>`coalesce(sum(${rollups.outputTokens}), 0)::float8`,
      costUsd: sql<string>`coalesce(sum(${rollups.costUsd}), 0)::text`,
    })
    .from(rollups);

  return toTraceKpis(row);
}

/** Sparse UTC-day aggregates for volume and KPI trend charts. */
export async function getTraceDailyAggregates(
  projectId: string,
  window: TraceWindow,
  db: TraceQueriesDb = getDb(),
): Promise<TraceDailyAggregate[]> {
  const rollups = traceRollups(projectId, window, db);
  const day = sql<string>`to_char(date_trunc('day', ${rollups.startedAt} at time zone 'UTC'), 'YYYY-MM-DD')`;
  const rows = await db
    .select({
      day,
      traceCount: sql<number>`count(*)::int`,
      errorTraceCount: sql<number>`coalesce(sum(${rollups.hasError}), 0)::int`,
      averageLatencyMs: sql<number>`coalesce(avg(${rollups.durationMs}), 0)::float8`,
      inputTokens: sql<number>`coalesce(sum(${rollups.inputTokens}), 0)::float8`,
      outputTokens: sql<number>`coalesce(sum(${rollups.outputTokens}), 0)::float8`,
      costUsd: sql<string>`coalesce(sum(${rollups.costUsd}), 0)::text`,
    })
    .from(rollups)
    .groupBy(day)
    .orderBy(day);

  return rows.map(toTraceDailyAggregate);
}

/**
 * `getTraceKpis` read off the `otel_trace_summaries` silver table instead of the
 * live span join — identical shape, cost bounded by trace count rather than span
 * count, which is what keeps the KPI band renderable on the densest projects.
 *
 * Percentiles stay exact (both paths aggregate exactly one duration per trace).
 * The one behavioral difference is the boundary rule: a summary pins the
 * whole-trace canonical representative, so a window-straddling trace lands in
 * the window that representative belongs to rather than being re-picked per
 * window. Pinned by an integration test.
 */
export async function getTraceKpisFromSummaries(
  projectId: string,
  window: TraceWindow,
  db: TraceQueriesDb = getDb(),
): Promise<TraceKpis> {
  const [row] = await db
    .select({
      traceCount: sql<number>`count(*)::int`,
      errorTraceCount: sql<number>`count(*) filter (where ${otelTraceSummaries.hasError})::int`,
      averageLatencyMs: sql<number | null>`avg(${otelTraceSummaries.durationMs})::float8`,
      p50LatencyMs: sql<
        number | null
      >`percentile_cont(0.5) within group (order by ${otelTraceSummaries.durationMs})::float8`,
      p95LatencyMs: sql<
        number | null
      >`percentile_cont(0.95) within group (order by ${otelTraceSummaries.durationMs})::float8`,
      inputTokens: sql<number>`coalesce(sum(${otelTraceSummaries.inputTokens}), 0)::float8`,
      outputTokens: sql<number>`coalesce(sum(${otelTraceSummaries.outputTokens}), 0)::float8`,
      costUsd: sql<string>`coalesce(sum(${otelTraceSummaries.costUsd}), 0)::text`,
    })
    .from(otelTraceSummaries)
    .where(summaryWindow(projectId, window));

  return toTraceKpis(row);
}

/** `getTraceDailyAggregates` off the summary table. See `getTraceKpisFromSummaries`. */
export async function getTraceDailyAggregatesFromSummaries(
  projectId: string,
  window: TraceWindow,
  db: TraceQueriesDb = getDb(),
): Promise<TraceDailyAggregate[]> {
  const day = sql<string>`to_char(date_trunc('day', ${otelTraceSummaries.startedAt} at time zone 'UTC'), 'YYYY-MM-DD')`;
  const rows = await db
    .select({
      day,
      traceCount: sql<number>`count(*)::int`,
      errorTraceCount: sql<number>`count(*) filter (where ${otelTraceSummaries.hasError})::int`,
      averageLatencyMs: sql<number>`coalesce(avg(${otelTraceSummaries.durationMs}), 0)::float8`,
      inputTokens: sql<number>`coalesce(sum(${otelTraceSummaries.inputTokens}), 0)::float8`,
      outputTokens: sql<number>`coalesce(sum(${otelTraceSummaries.outputTokens}), 0)::float8`,
      costUsd: sql<string>`coalesce(sum(${otelTraceSummaries.costUsd}), 0)::text`,
    })
    .from(otelTraceSummaries)
    .where(summaryWindow(projectId, window))
    .groupBy(day)
    .orderBy(day);

  return rows.map(toTraceDailyAggregate);
}

/** Explain an empty traces view without evaluating the ingest feature flag. */
export async function getTracesIngestDiagnostics(
  projectId: string,
  db: TraceQueriesDb = getDb(),
): Promise<TracesIngestDiagnostics> {
  const [eventRows, spanRows] = await Promise.all([
    db
      .select({
        latest: sql<
          string | Date | null
        >`max(coalesce(${events.occurredAt}, ${events.receivedAt}))`,
      })
      .from(events)
      .where(eq(events.projectId, projectId)),
    db
      .select({
        latest: sql<string | Date | null>`max(${otelSpans.startedAt})`,
      })
      .from(otelSpans)
      .where(eq(otelSpans.projectId, projectId)),
  ]);
  const latestEventAt = dateOrNull(eventRows[0]?.latest);
  const latestSpanAt = dateOrNull(spanRows[0]?.latest);

  return {
    hasEvents: latestEventAt !== null,
    hasSpans: latestSpanAt !== null,
    latestEventAt,
    latestSpanAt,
  };
}

/**
 * Delete one bounded batch of spans whose server receipt time has expired.
 *
 * `started_at` is producer-controlled and may be skewed or malicious, so it
 * must never determine retention.
 */
export async function pruneExpiredOtelSpans(
  options: PruneExpiredOtelSpansOptions = {},
  db: TraceMaintenanceDb = getDb(),
): Promise<number> {
  const cutoff = new Date(
    (options.now?.getTime() ?? Date.now()) -
      retentionDays(options.retentionDays) * MILLISECONDS_PER_DAY,
  );
  const expiredIds = db
    .select({ id: otelSpans.id })
    .from(otelSpans)
    .where(lt(otelSpans.receivedAt, cutoff))
    .orderBy(asc(otelSpans.receivedAt), asc(otelSpans.id))
    .limit(OTEL_SPAN_PRUNE_BATCH_SIZE);
  const deleted = await db
    .delete(otelSpans)
    .where(inArray(otelSpans.id, expiredIds))
    .returning({ id: otelSpans.id });

  return deleted.length;
}

/**
 * Delete one bounded batch of logs whose server receipt time has expired.
 *
 * Producer event time may be skewed or malicious, so it must never determine
 * retention.
 */
export async function pruneExpiredOtelLogs(
  options: PruneExpiredOtelLogsOptions = {},
  db: TraceMaintenanceDb = getDb(),
): Promise<number> {
  const cutoff = new Date(
    (options.now?.getTime() ?? Date.now()) -
      logRetentionDays(options.retentionDays) * MILLISECONDS_PER_DAY,
  );
  const expiredIds = db
    .select({ id: otelLogs.id })
    .from(otelLogs)
    .where(lt(otelLogs.receivedAt, cutoff))
    .orderBy(asc(otelLogs.receivedAt), asc(otelLogs.id))
    .limit(OTEL_LOG_PRUNE_BATCH_SIZE);
  const deleted = await db
    .delete(otelLogs)
    .where(inArray(otelLogs.id, expiredIds))
    .returning({ id: otelLogs.id });

  return deleted.length;
}

/**
 * Delete one bounded batch of trace summaries whose spans have all expired.
 *
 * Keyed on the same server-receipt clock and retention window as
 * `pruneExpiredOtelSpans`, so a summary never outlives the spans it was derived
 * from. Safe to run beside the sweep: the sweep only rebuilds a row when one of
 * that trace's spans is newly received, which a fully-pruned trace has none of.
 */
export async function pruneExpiredTraceSummaries(
  options: PruneExpiredTraceSummariesOptions = {},
  db: TraceMaintenanceDb = getDb(),
): Promise<number> {
  const cutoff = new Date(
    (options.now?.getTime() ?? Date.now()) -
      retentionDays(options.retentionDays) * MILLISECONDS_PER_DAY,
  );
  const expired = db
    .select({
      projectId: otelTraceSummaries.projectId,
      traceId: otelTraceSummaries.traceId,
    })
    .from(otelTraceSummaries)
    .where(lt(otelTraceSummaries.spansMaxReceivedAt, cutoff))
    .orderBy(
      asc(otelTraceSummaries.spansMaxReceivedAt),
      asc(otelTraceSummaries.projectId),
      asc(otelTraceSummaries.traceId),
    )
    .limit(TRACE_SUMMARY_PRUNE_BATCH_SIZE);
  const deleted = await db
    .delete(otelTraceSummaries)
    // Composite key, so the batch is matched row-wise rather than by an id list.
    .where(sql`(${otelTraceSummaries.projectId}, ${otelTraceSummaries.traceId}) in (${expired})`)
    .returning({ traceId: otelTraceSummaries.traceId });

  return deleted.length;
}

function traceMembershipSubqueries(
  projectId: string,
  options: ListTracesOptions,
  db: TraceQueriesDb,
) {
  const spanToolName = sql<string | null>`${otelSpans.attributes} ->> 'gen_ai.tool.name'`;
  const dimensionTraceIds =
    options.spanName !== undefined || options.model !== undefined || options.tool !== undefined
      ? db
          .select({ traceId: otelSpans.traceId })
          .from(otelSpans)
          .where(
            and(
              eq(otelSpans.projectId, projectId),
              options.since ? gte(otelSpans.startedAt, options.since) : undefined,
              options.until ? lt(otelSpans.startedAt, options.until) : undefined,
              options.spanName !== undefined
                ? containsText(otelSpans.name, options.spanName)
                : undefined,
              options.model !== undefined
                ? containsText(otelSpans.model, options.model)
                : undefined,
              options.tool !== undefined ? containsText(spanToolName, options.tool) : undefined,
            ),
          )
          .groupBy(otelSpans.traceId)
      : undefined;
  const errorTraceIds = options.errorOnly
    ? db
        .select({ traceId: otelSpans.traceId })
        .from(otelSpans)
        .where(
          and(
            eq(otelSpans.projectId, projectId),
            options.since ? gte(otelSpans.startedAt, options.since) : undefined,
            options.until ? lt(otelSpans.startedAt, options.until) : undefined,
            eq(otelSpans.statusCode, 2),
          ),
        )
        .groupBy(otelSpans.traceId)
    : undefined;
  const experimentTraceIds =
    options.experiment !== undefined || options.arm !== undefined
      ? db
          .select({ traceId: otelSpans.traceId })
          .from(otelSpans)
          .where(
            and(
              eq(otelSpans.projectId, projectId),
              options.since ? gte(otelSpans.startedAt, options.since) : undefined,
              options.until ? lt(otelSpans.startedAt, options.until) : undefined,
              options.experiment !== undefined
                ? containsText(otelSpans.experimentName, options.experiment)
                : undefined,
              options.arm !== undefined
                ? containsText(otelSpans.experimentArm, options.arm)
                : undefined,
            ),
          )
          .groupBy(otelSpans.traceId)
      : undefined;
  const facetTraceIds = hasTraceFacetFilters(options)
    ? db
        .select({ traceId: otelSpans.traceId })
        .from(otelSpans)
        .where(
          and(
            eq(otelSpans.projectId, projectId),
            spanFacetFilter({
              since: options.since,
              until: options.until,
              name: options.spanName,
              model: options.model,
              tool: options.tool,
              experiment: options.experiment,
              arm: options.arm,
              errorOnly: options.errorOnly,
              services: options.services,
              names: options.names,
              statuses: options.statuses,
              kinds: options.kinds,
              environments: options.environments,
              models: options.models,
              experiments: options.experiments,
              arms: options.arms,
              minDurationMs: options.minDurationMs,
              maxDurationMs: options.maxDurationMs,
              minTokens: options.minTokens,
              maxTokens: options.maxTokens,
              minCostUsd: options.minCostUsd,
              maxCostUsd: options.maxCostUsd,
            }),
          ),
        )
        .groupBy(otelSpans.traceId)
    : undefined;

  return {
    dimensionTraceIds,
    errorTraceIds,
    experimentTraceIds,
    facetTraceIds,
  };
}

function traceRollups(projectId: string, window: TraceWindow, db: TraceQueriesDb) {
  const representativeColumns = {
    traceId: otelSpans.traceId,
    rootName: otelSpans.name,
    startedAt: otelSpans.startedAt,
    durationMs: otelSpans.durationMs,
  };
  const windowBounds = and(
    gte(otelSpans.startedAt, window.since),
    lt(otelSpans.startedAt, window.until),
  );
  const rootedTraces = db
    .selectDistinctOn([otelSpans.traceId], representativeColumns)
    .from(otelSpans)
    .where(and(eq(otelSpans.projectId, projectId), isNull(otelSpans.parentSpanId), windowBounds))
    .orderBy(asc(otelSpans.traceId), asc(otelSpans.startedAt), asc(otelSpans.spanId));
  const inWindowRootTraceIds = db
    .select({ traceId: otelSpans.traceId })
    .from(otelSpans)
    .where(and(eq(otelSpans.projectId, projectId), isNull(otelSpans.parentSpanId), windowBounds))
    .groupBy(otelSpans.traceId);
  const inWindowRootless = db
    .select({ traceId: otelSpans.traceId })
    .from(otelSpans)
    .where(and(eq(otelSpans.projectId, projectId), windowBounds))
    .groupBy(otelSpans.traceId)
    .having(notInArray(otelSpans.traceId, inWindowRootTraceIds))
    .as("aggregate_in_window_rootless");
  const rootProbe = alias(otelSpans, "aggregate_root_probe");
  const rootlessCandidates = db
    .select({ traceId: inWindowRootless.traceId })
    .from(inWindowRootless)
    .where(
      notExists(
        db
          .select({ present: sql`1` })
          .from(rootProbe)
          .where(
            and(
              eq(rootProbe.projectId, projectId),
              eq(rootProbe.traceId, inWindowRootless.traceId),
              isNull(rootProbe.parentSpanId),
            ),
          ),
      ),
    )
    .as("aggregate_rootless_candidates");
  const rootlessRepresentative = db
    .select(representativeColumns)
    .from(otelSpans)
    .where(
      and(
        eq(otelSpans.projectId, projectId),
        windowBounds,
        eq(otelSpans.traceId, rootlessCandidates.traceId),
      ),
    )
    .orderBy(asc(otelSpans.startedAt), asc(otelSpans.spanId))
    .limit(1)
    .as("aggregate_rootless_representative");
  const rootlessTraces = db
    .select({
      traceId: rootlessRepresentative.traceId,
      rootName: rootlessRepresentative.rootName,
      startedAt: rootlessRepresentative.startedAt,
      durationMs: rootlessRepresentative.durationMs,
    })
    .from(rootlessCandidates)
    .crossJoinLateral(rootlessRepresentative);
  const selectedRoots = unionAll(rootedTraces, rootlessTraces).as("selected_trace_roots");

  return db
    .select({
      traceId: selectedRoots.traceId,
      rootName: selectedRoots.rootName,
      startedAt: selectedRoots.startedAt,
      durationMs: selectedRoots.durationMs,
      hasError: sql<number>`max(case when ${otelSpans.statusCode} = 2 then 1 else 0 end)::int`.as(
        "has_error",
      ),
      inputTokens: sql<number>`coalesce(sum(${otelSpans.inputTokens}), 0)::float8`.as(
        "input_tokens",
      ),
      outputTokens: sql<number>`coalesce(sum(${otelSpans.outputTokens}), 0)::float8`.as(
        "output_tokens",
      ),
      costUsd: sql<string>`coalesce(sum(${otelSpans.costUsd}), 0)`.as("cost_usd"),
    })
    .from(selectedRoots)
    .innerJoin(
      otelSpans,
      and(eq(otelSpans.projectId, projectId), eq(otelSpans.traceId, selectedRoots.traceId)),
    )
    .groupBy(
      selectedRoots.traceId,
      selectedRoots.rootName,
      selectedRoots.startedAt,
      selectedRoots.durationMs,
    )
    .as("trace_rollups");
}

/** Window predicate for the summary reads, riding `(project_id, started_at)`. */
function summaryWindow(projectId: string, window: TraceWindow) {
  return and(
    eq(otelTraceSummaries.projectId, projectId),
    gte(otelTraceSummaries.startedAt, window.since),
    lt(otelTraceSummaries.startedAt, window.until),
  );
}

/**
 * Shared by the live and summary KPI reads so the two can never drift in how
 * they derive the rate, the token total, or the empty-window nulls.
 */
function toTraceKpis(row: TraceKpiRow | undefined): TraceKpis {
  const traceCount = row?.traceCount ?? 0;
  const errorTraceCount = row?.errorTraceCount ?? 0;
  const inputTokens = row?.inputTokens ?? 0;
  const outputTokens = row?.outputTokens ?? 0;

  return {
    traceCount,
    errorTraceCount,
    errorRate: traceCount === 0 ? 0 : errorTraceCount / traceCount,
    averageLatencyMs: row?.averageLatencyMs ?? null,
    p50LatencyMs: row?.p50LatencyMs ?? null,
    p95LatencyMs: row?.p95LatencyMs ?? null,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    costUsd: Number(row?.costUsd ?? 0),
  };
}

function toTraceDailyAggregate(row: TraceDailyRow): TraceDailyAggregate {
  return {
    ...row,
    totalTokens: row.inputTokens + row.outputTokens,
    costUsd: Number(row.costUsd),
  };
}

function dateOrNull(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  return value instanceof Date ? value : new Date(value);
}

// The exact character set JavaScript's `String.prototype.trim()` strips, so the
// SQL blank filter below and the JS backstop in `getTraceFacets` agree on what a
// "blank" facet value is. Enumerated explicitly (not POSIX `[[:space:]]`, whose
// non-ASCII coverage is locale-dependent) so an exotic-whitespace-only value —
// NBSP, BOM, ideographic space — is dropped *before* ranking rather than
// consuming a top-N slot and shoving out a real value.
const TRIM_WHITESPACE_CHARS =
  "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680" +
  "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a" +
  "\u2028\u2029\u202f\u205f\u3000\ufeff";

async function countFacetValues(
  projectId: string,
  options: TraceFacetOptions,
  dimensions: readonly TraceFacetDimension[],
  db: TraceQueriesDb,
  omittedFacet?: TraceFacetKey,
): Promise<TraceFacetCountRow[]> {
  // Aliased so the ranking layer below can reference them as subquery columns.
  const facet = sql<TraceFacetKey>`case ${sql.join(
    dimensions.map(([key, expression]) => sql`when grouping(${expression}) = 0 then ${key}`),
    sql.raw(" "),
  )} end`.as("facet");
  const value = sql<string | null>`case ${sql.join(
    dimensions.map(([, expression]) => sql`when grouping(${expression}) = 0 then ${expression}`),
    sql.raw(" "),
  )} end`.as("value");
  const count = sql<number>`count(*)::int`.as("count");

  // Single grouped scan across every dimension (grouping sets), then keep only
  // the top `TRACE_FACET_VALUE_LIMIT` values per facet *inside SQL* — a
  // high-cardinality dimension (span/tool name) must not ship an unbounded row
  // set over the wire in a read whose whole point is speed. Null/blank values
  // are dropped before ranking so they never consume a slot, mirroring the
  // JS-side skip in `getTraceFacets`.
  const counted = db
    .select({ facet, value, count })
    .from(otelSpans)
    .where(and(eq(otelSpans.projectId, projectId), spanFacetFilter(options, omittedFacet)))
    .groupBy(
      sql`grouping sets (${sql.join(
        dimensions.map(([, expression]) => sql`(${expression})`),
        sql`, `,
      )})`,
    )
    .as("facet_counts");

  const ranked = db
    .select({
      facet: counted.facet,
      value: counted.value,
      count: counted.count,
      rank: sql<number>`row_number() over (partition by ${counted.facet} order by ${counted.count} desc, ${counted.value} asc)`.as(
        "facet_rank",
      ),
    })
    .from(counted)
    .where(
      sql`${counted.value} is not null and btrim(${counted.value}, ${TRIM_WHITESPACE_CHARS}) <> ''`,
    )
    .as("ranked_facets");

  return db
    .select({ facet: ranked.facet, value: ranked.value, count: ranked.count })
    .from(ranked)
    .where(lte(ranked.rank, TRACE_FACET_VALUE_LIMIT))
    .orderBy(asc(ranked.facet), desc(ranked.count), asc(ranked.value));
}

function hasActiveFacetFilter(options: TraceFacetOptions, facet: TraceFacetKey): boolean {
  switch (facet) {
    case "service":
      return Boolean(options.services?.length);
    case "name":
      return Boolean(options.names?.length);
    case "status":
      return Boolean(options.statuses?.length);
    case "kind":
      return Boolean(options.kinds?.length);
    case "environment":
      return Boolean(options.environments?.length);
    case "model":
      return Boolean(options.models?.length);
    case "tool":
      return Boolean(options.tool);
    case "experiment":
      return Boolean(options.experiments?.length);
    case "arm":
      return Boolean(options.arms?.length);
  }
}

function spanFacetFilter(options: TraceFacetOptions, omittedFacet?: TraceFacetKey) {
  const toolName = sql<string | null>`${otelSpans.attributes} ->> 'gen_ai.tool.name'`;
  const environment = sql<
    string | null
  >`coalesce(${otelSpans.attributes} ->> 'deployment.environment.name', ${otelSpans.attributes} ->> 'deployment.environment')`;
  const totalTokens = sql<number>`coalesce(${otelSpans.inputTokens}, 0) + coalesce(${otelSpans.outputTokens}, 0)`;
  const costUsd = sql<number>`coalesce(${otelSpans.costUsd}, 0)::float8`;

  return and(
    options.since ? gte(otelSpans.startedAt, options.since) : undefined,
    options.until ? lt(otelSpans.startedAt, options.until) : undefined,
    options.scope === "root" ? isNull(otelSpans.parentSpanId) : undefined,
    options.name ? containsText(otelSpans.name, options.name) : undefined,
    options.model ? containsText(otelSpans.model, options.model) : undefined,
    omittedFacet !== "tool" && options.tool ? containsText(toolName, options.tool) : undefined,
    options.experiment ? containsText(otelSpans.experimentName, options.experiment) : undefined,
    options.arm ? containsText(otelSpans.experimentArm, options.arm) : undefined,
    options.errorOnly ? eq(otelSpans.statusCode, 2) : undefined,
    omittedFacet !== "service" && options.services?.length
      ? inArray(otelSpans.serviceName, [...options.services])
      : undefined,
    omittedFacet !== "name" && options.names?.length
      ? inArray(otelSpans.name, [...options.names])
      : undefined,
    omittedFacet !== "status" && options.statuses?.length
      ? inArray(otelSpans.statusCode, [...options.statuses])
      : undefined,
    omittedFacet !== "kind" && options.kinds?.length
      ? inArray(otelSpans.kind, [...options.kinds])
      : undefined,
    omittedFacet !== "environment" && options.environments?.length
      ? inArray(environment, [...options.environments])
      : undefined,
    omittedFacet !== "model" && options.models?.length
      ? inArray(otelSpans.model, [...options.models])
      : undefined,
    omittedFacet !== "experiment" && options.experiments?.length
      ? inArray(otelSpans.experimentName, [...options.experiments])
      : undefined,
    omittedFacet !== "arm" && options.arms?.length
      ? inArray(otelSpans.experimentArm, [...options.arms])
      : undefined,
    options.minDurationMs !== undefined
      ? gte(otelSpans.durationMs, options.minDurationMs)
      : undefined,
    options.maxDurationMs !== undefined
      ? lte(otelSpans.durationMs, options.maxDurationMs)
      : undefined,
    options.minTokens !== undefined ? gte(totalTokens, options.minTokens) : undefined,
    options.maxTokens !== undefined ? lte(totalTokens, options.maxTokens) : undefined,
    options.minCostUsd !== undefined ? gte(costUsd, options.minCostUsd) : undefined,
    options.maxCostUsd !== undefined ? lte(costUsd, options.maxCostUsd) : undefined,
  );
}

function hasTraceFacetFilters(options: TraceFacetFilters): boolean {
  return Boolean(
    options.services?.length ||
      options.names?.length ||
      options.statuses?.length ||
      options.kinds?.length ||
      options.environments?.length ||
      options.models?.length ||
      options.experiments?.length ||
      options.arms?.length ||
      options.minDurationMs !== undefined ||
      options.maxDurationMs !== undefined ||
      options.minTokens !== undefined ||
      options.maxTokens !== undefined ||
      options.minCostUsd !== undefined ||
      options.maxCostUsd !== undefined,
  );
}

function pageSize(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_TRACE_PAGE_SIZE;
  }
  return Math.min(MAX_TRACE_PAGE_SIZE, Math.max(1, Math.trunc(limit)));
}

function spanPageSize(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_SPAN_PAGE_SIZE;
  }
  return Math.min(MAX_SPAN_PAGE_SIZE, Math.max(1, Math.trunc(limit)));
}

function operationSortExpression(
  sort: OperationSort,
  key: typeof otelSpans.name | typeof otelSpans.model | ReturnType<typeof sql<string | null>>,
  aggregates: {
    count: ReturnType<typeof sql<number>>;
    errorRate: ReturnType<typeof sql<number>>;
    p50: ReturnType<typeof sql<number>>;
    p95: ReturnType<typeof sql<number>>;
    p99: ReturnType<typeof sql<number>>;
    cost: ReturnType<typeof sql<number>>;
    tokens: ReturnType<typeof sql<number>>;
  },
) {
  switch (sort) {
    case "key":
      return key;
    case "errorRate":
      return aggregates.errorRate;
    case "p50":
      return aggregates.p50;
    case "p95":
      return aggregates.p95;
    case "p99":
      return aggregates.p99;
    case "cost":
      return aggregates.cost;
    case "tokens":
      return aggregates.tokens;
    case "count":
      return aggregates.count;
  }
}

function retentionDays(override?: number): number {
  if (isValidRetentionDays(override)) return override;
  const configured = Number(process.env.OTEL_SPAN_RETENTION_DAYS);
  return isValidRetentionDays(configured) ? configured : DEFAULT_OTEL_SPAN_RETENTION_DAYS;
}

function logRetentionDays(override?: number): number {
  if (isValidRetentionDays(override)) return override;
  const configuredLogRetention = Number(process.env.OTEL_LOG_RETENTION_DAYS);
  if (isValidRetentionDays(configuredLogRetention)) {
    return configuredLogRetention;
  }
  const configuredSpanRetention = Number(process.env.OTEL_SPAN_RETENTION_DAYS);
  return isValidRetentionDays(configuredSpanRetention)
    ? configuredSpanRetention
    : DEFAULT_OTEL_SPAN_RETENTION_DAYS;
}

function isValidRetentionDays(value: number | undefined): value is number {
  return (
    value !== undefined &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_SAFE_RETENTION_DAYS
  );
}
