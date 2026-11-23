import { and, asc, eq, gte, inArray, isNotNull, lt, Subquery, sql } from "drizzle-orm";
// NOT public API: `Subquery`, `SubqueryWithSelection`, and `SelectionProxyHandler`
// are drizzle internals used only to smuggle a `WITH … AS MATERIALIZED` barrier
// past drizzle's query builder (it has no MATERIALIZED hint — see
// `selectedTraceRoots`). A drizzle bump can move or reshape them silently; the
// SQL-shape guard in `experiment-queries.test.ts` ("materializes trace-root
// stages") must stay green through any such upgrade.
import type { SubqueryWithSelection } from "drizzle-orm/pg-core/subquery";
import { SelectionProxyHandler } from "drizzle-orm/selection-proxy";
import { otelSpans } from "@/lib/ingest/otlp/schema";
import { deterministicEventId } from "@/lib/ingest/trace-events/parse";
import { traceEventHits } from "@/lib/ingest/trace-events/schema";
import { getDb } from "@/lib/platform/db/client";
import {
  type ExperimentDetectionAggregates,
  foldExperimentTraceArms,
} from "@/lib/synthesis/experiments/fold";
import type { ExperimentQueries, ExperimentWindow } from "@/lib/synthesis/experiments/service";
import type {
  ArmMetricAggregate,
  ArmSearchSpan,
  ExperimentArmAggregate,
  MultiArmTraceCount,
} from "@/lib/synthesis/experiments/types";
import {
  getExperimentConversionMetrics,
  getExperimentLifecycleDiagnostics,
  listExperimentLifecycleArmMetrics,
} from "./experiment-lifecycle-queries";

export type ExperimentQueriesDb = Pick<
  ReturnType<typeof getDb>,
  "select" | "selectDistinct" | "selectDistinctOn"
>;

const HIT_QUERY_BATCH_SIZE = 100;
const NON_BLANK_EXPERIMENT_NAME = sql`btrim(${otelSpans.experimentName}) <> ''`;
const NON_BLANK_EXPERIMENT_ARM = sql`btrim(${otelSpans.experimentArm}) <> ''`;

export function createExperimentQueries(db: ExperimentQueriesDb = getDb()): ExperimentQueries {
  return {
    listExperimentDetectionAggregates: (projectId, window) =>
      listExperimentDetectionAggregates(projectId, window, db),
    getArmMetricAggregates: (projectId, experimentName, window) =>
      getArmMetricAggregates(projectId, experimentName, window, db),
    listArmSearchSpans: (projectId, experimentName, window) =>
      listArmSearchSpans(projectId, experimentName, window, db),
    listExperimentLifecycleArmMetrics: (projectId, experimentName, window) =>
      listExperimentLifecycleArmMetrics(projectId, experimentName, window, db),
    getExperimentLifecycleDiagnostics: (projectId, window) =>
      getExperimentLifecycleDiagnostics(projectId, window, db),
    getExperimentConversionMetrics: (projectId, experimentName, window) =>
      getExperimentConversionMetrics(projectId, experimentName, window, db),
  };
}

export const experimentQueries = {
  listExperimentDetectionAggregates,
  getArmMetricAggregates,
  listArmSearchSpans,
  listExperimentLifecycleArmMetrics,
  getExperimentLifecycleDiagnostics,
  getExperimentConversionMetrics,
} satisfies ExperimentQueries;

// Both experiment-detection rollups (per-arm aggregates + multi-arm trace
// counts) fold out of a single scan of the selected-root ⋈ experiment-tagged
// span grain. Collapsing what used to be three inlined scans (arm aggregates
// rendered its grain twice, multi-arm once) to one keeps the densest projects
// under #101's statement timeout. The `listExperimentArmAggregates` /
// `countMultiArmTraces` wrappers stay exported so their integration tests keep
// asserting each half in isolation.
export async function listExperimentDetectionAggregates(
  projectId: string,
  window: ExperimentWindow,
  db: ExperimentQueriesDb = getDb(),
): Promise<ExperimentDetectionAggregates> {
  const selectedRoots = selectedTraceRoots(projectId, window, db, "experiment_detection");
  const grainRows = await db
    .select({
      experimentName: otelSpans.experimentName,
      arm: otelSpans.experimentArm,
      traceId: selectedRoots.traceId,
      firstSeenAt: sql<Date | string>`min(${otelSpans.startedAt})`,
      lastSeenAt: sql<Date | string>`max(${otelSpans.startedAt})`,
    })
    .from(selectedRoots)
    .innerJoin(
      otelSpans,
      and(eq(otelSpans.projectId, projectId), eq(otelSpans.traceId, selectedRoots.traceId)),
    )
    .where(
      and(
        isNotNull(otelSpans.experimentName),
        isNotNull(otelSpans.experimentArm),
        NON_BLANK_EXPERIMENT_NAME,
        NON_BLANK_EXPERIMENT_ARM,
      ),
    )
    .groupBy(otelSpans.experimentName, otelSpans.experimentArm, selectedRoots.traceId);

  return foldExperimentTraceArms(
    grainRows.map((row) => ({
      experimentName: row.experimentName!,
      arm: row.arm!,
      traceId: row.traceId,
      firstSeenAt: dateValue(row.firstSeenAt),
      lastSeenAt: dateValue(row.lastSeenAt),
    })),
  );
}

export async function listExperimentArmAggregates(
  projectId: string,
  window: ExperimentWindow,
  db: ExperimentQueriesDb = getDb(),
): Promise<ExperimentArmAggregate[]> {
  return (await listExperimentDetectionAggregates(projectId, window, db)).armAggregates;
}

export async function countMultiArmTraces(
  projectId: string,
  window: ExperimentWindow,
  db: ExperimentQueriesDb = getDb(),
): Promise<MultiArmTraceCount[]> {
  return (await listExperimentDetectionAggregates(projectId, window, db)).multiArmCounts;
}

export async function getArmMetricAggregates(
  projectId: string,
  experimentName: string,
  window: ExperimentWindow,
  db: ExperimentQueriesDb = getDb(),
): Promise<ArmMetricAggregate[]> {
  const selectedRoots = selectedTraceRoots(projectId, window, db, "experiment_metrics");
  const rankedArmRoots = db
    .select({
      traceId: selectedRoots.traceId,
      arm: otelSpans.experimentArm,
      durationMs: otelSpans.durationMs,
      armRootRank:
        sql<number>`(row_number() over (partition by ${selectedRoots.traceId}, ${otelSpans.experimentArm} order by case when ${otelSpans.parentSpanId} is null then 0 else 1 end, ${otelSpans.startedAt}, ${otelSpans.spanId}))::int`.as(
          "experiment_arm_root_rank",
        ),
    })
    .from(selectedRoots)
    .innerJoin(
      otelSpans,
      and(eq(otelSpans.projectId, projectId), eq(otelSpans.traceId, selectedRoots.traceId)),
    )
    .where(
      and(
        eq(otelSpans.experimentName, experimentName),
        isNotNull(otelSpans.experimentArm),
        NON_BLANK_EXPERIMENT_NAME,
        NON_BLANK_EXPERIMENT_ARM,
      ),
    )
    .as("ranked_experiment_arm_roots");
  const selectedArmRoots = db
    .select({
      traceId: rankedArmRoots.traceId,
      arm: rankedArmRoots.arm,
      durationMs: rankedArmRoots.durationMs,
    })
    .from(rankedArmRoots)
    .where(eq(rankedArmRoots.armRootRank, 1))
    .as("selected_experiment_arm_roots");
  const traceArmRollups = db
    .select({
      traceId: selectedArmRoots.traceId,
      arm: selectedArmRoots.arm,
      latencyMs: selectedArmRoots.durationMs,
      hasError: sql<number>`max(case when ${otelSpans.statusCode} = 2 then 1 else 0 end)::int`.as(
        "has_error",
      ),
      inputTokens:
        sql<number>`coalesce(sum(${otelSpans.inputTokens}) filter (where ${otelSpans.spanClass} = 'llm_call'), 0)::float8`.as(
          "input_tokens",
        ),
      outputTokens:
        sql<number>`coalesce(sum(${otelSpans.outputTokens}) filter (where ${otelSpans.spanClass} = 'llm_call'), 0)::float8`.as(
          "output_tokens",
        ),
      costUsd:
        sql<number>`coalesce(sum(${otelSpans.costUsd}) filter (where ${otelSpans.spanClass} = 'llm_call'), 0)::float8`.as(
          "cost_usd",
        ),
      searchCount:
        sql<number>`count(*) filter (where ${otelSpans.spanClass} = 'ratel_search')::float8`.as(
          "search_count",
        ),
      searchHitCount: sql<number | null>`(case
          when count(*) filter (
            where ${otelSpans.spanClass} = 'ratel_search'
              and ${otelSpans.searchHitCount} is null
          ) > 0 then null
          else coalesce(
            sum(${otelSpans.searchHitCount}) filter (
              where ${otelSpans.spanClass} = 'ratel_search'
            ),
            0
          )
        end)::float8`.as("search_hit_count"),
    })
    .from(selectedArmRoots)
    .innerJoin(
      otelSpans,
      and(
        eq(otelSpans.projectId, projectId),
        eq(otelSpans.traceId, selectedArmRoots.traceId),
        eq(otelSpans.experimentName, experimentName),
        eq(otelSpans.experimentArm, selectedArmRoots.arm),
      ),
    )
    .groupBy(selectedArmRoots.traceId, selectedArmRoots.arm, selectedArmRoots.durationMs)
    .as("experiment_trace_arm_rollups");
  const rows = await db
    .select({
      arm: traceArmRollups.arm,
      traceCount: sql<number>`count(*)::int`,
      errorTraceCount: sql<number>`count(*) filter (where ${traceArmRollups.hasError} = 1)::int`,
      averageLatencyMs: sql<number>`avg(${traceArmRollups.latencyMs})::float8`,
      p50LatencyMs: sql<number>`percentile_cont(0.5) within group (order by ${traceArmRollups.latencyMs})::float8`,
      p95LatencyMs: sql<number>`percentile_cont(0.95) within group (order by ${traceArmRollups.latencyMs})::float8`,
      averageInputTokens: sql<number>`avg(${traceArmRollups.inputTokens})::float8`,
      averageOutputTokens: sql<number>`avg(${traceArmRollups.outputTokens})::float8`,
      averageCostUsd: sql<number>`avg(${traceArmRollups.costUsd})::float8`,
      averageSearchCount: sql<number>`avg(${traceArmRollups.searchCount})::float8`,
      averageSearchHitCount: sql<number | null>`(case
          when count(*) filter (
            where ${traceArmRollups.searchHitCount} is null
          ) > 0 then null
          else avg(${traceArmRollups.searchHitCount})
        end)::float8`,
    })
    .from(traceArmRollups)
    .groupBy(traceArmRollups.arm)
    .orderBy(asc(traceArmRollups.arm));

  return rows.map((row) => ({
    arm: row.arm!,
    traceCount: row.traceCount,
    errorTraceCount: row.errorTraceCount,
    averageLatencyMs: row.averageLatencyMs,
    p50LatencyMs: row.p50LatencyMs,
    p95LatencyMs: row.p95LatencyMs,
    averageInputTokens: row.averageInputTokens,
    averageOutputTokens: row.averageOutputTokens,
    averageCostUsd: row.averageCostUsd,
    averageSearchCount: row.averageSearchCount,
    averageSearchHitCount: row.averageSearchHitCount,
  }));
}

export async function listArmSearchSpans(
  projectId: string,
  experimentName: string,
  window: ExperimentWindow,
  db: ExperimentQueriesDb = getDb(),
): Promise<ArmSearchSpan[]> {
  const selectedRoots = selectedTraceRoots(projectId, window, db, "experiment_searches");
  const rows = await db
    .select({
      arm: otelSpans.experimentArm,
      traceId: otelSpans.traceId,
      spanId: otelSpans.spanId,
      reportedHitCount: otelSpans.searchHitCount,
    })
    .from(selectedRoots)
    .innerJoin(
      otelSpans,
      and(eq(otelSpans.projectId, projectId), eq(otelSpans.traceId, selectedRoots.traceId)),
    )
    .where(
      and(
        eq(otelSpans.experimentName, experimentName),
        isNotNull(otelSpans.experimentArm),
        NON_BLANK_EXPERIMENT_NAME,
        NON_BLANK_EXPERIMENT_ARM,
        eq(otelSpans.spanClass, "ratel_search"),
      ),
    )
    .orderBy(
      asc(otelSpans.experimentArm),
      asc(selectedRoots.startedAt),
      asc(otelSpans.traceId),
      asc(otelSpans.startedAt),
      asc(otelSpans.spanId),
    );
  const searchSpans: ArmSearchSpan[] = rows.map((row) => ({
    arm: row.arm!,
    traceId: row.traceId,
    spanId: row.spanId,
    reportedHitCount: row.reportedHitCount,
    hits: [],
  }));

  for (let offset = 0; offset < searchSpans.length; offset += HIT_QUERY_BATCH_SIZE) {
    const spansByEventId = new Map<string, ArmSearchSpan[]>();
    for (const span of searchSpans.slice(offset, offset + HIT_QUERY_BATCH_SIZE)) {
      const eventId = deterministicEventId(projectId, `otlp:span:${span.traceId}:${span.spanId}`);
      const eventSpans = spansByEventId.get(eventId) ?? [];
      eventSpans.push(span);
      spansByEventId.set(eventId, eventSpans);
    }
    const hitRows = await db
      .select({
        traceEventId: traceEventHits.traceEventId,
        rank: traceEventHits.rank,
        targetType: traceEventHits.targetType,
        targetId: traceEventHits.targetId,
        score: traceEventHits.score,
      })
      .from(traceEventHits)
      .where(
        and(
          eq(traceEventHits.projectId, projectId),
          inArray(traceEventHits.traceEventId, [...spansByEventId.keys()]),
          inArray(traceEventHits.targetType, ["tool", "skill"]),
        ),
      )
      .orderBy(
        asc(traceEventHits.traceEventId),
        asc(traceEventHits.rank),
        asc(traceEventHits.targetType),
        asc(traceEventHits.targetId),
      );

    for (const hit of hitRows) {
      if (hit.targetType !== "tool" && hit.targetType !== "skill") continue;
      for (const span of spansByEventId.get(hit.traceEventId) ?? []) {
        span.hits.push({
          type: hit.targetType,
          id: hit.targetId,
          rank: hit.rank,
          score: hit.score,
        });
      }
    }
  }

  return searchSpans;
}

// Picks one representative root per in-window trace and keeps it only when the
// representative's own start lands in the window — the inclusion rule the whole
// experiment path shares. The representative is the canonical root over the
// *whole* trace, ordered `(parent_span_id is null) desc, started_at asc,
// span_id asc`, so a trace whose earliest root fell out of window is excluded
// (unlike listTraces' earliest-in-window-root idiom — do not reuse it here).
//
// The candidate and representative stages are materialized so stale planner
// statistics cannot inline and repeatedly execute the window subquery. Drizzle
// has no MATERIALIZED API, so the CTEs live inside a raw-SQL derived table while
// the returned selection remains a normal typed subquery for every caller.
function selectedTraceRoots(
  projectId: string,
  window: ExperimentWindow,
  // Unused: the raw-SQL derived table binds `otelSpans` directly rather than
  // through a db handle. Kept for signature parity with the other stage helpers
  // so callers pass their db uniformly.
  _db: ExperimentQueriesDb,
  alias: string,
) {
  const candidateAlias = `${alias}_window_traces`;
  const repsAlias = `${alias}_reps`;
  const selectedAlias = `${alias}_selected_roots`;
  const traceId = sql.identifier("trace_id");
  const startedAt = sql.identifier("started_at");
  const fields = {
    traceId: otelSpans.traceId,
    startedAt: otelSpans.startedAt,
  };
  const query = sql`
    with ${sql.identifier(candidateAlias)} as materialized (
      select distinct ${otelSpans.traceId} as ${traceId}
        from ${otelSpans}
       where ${and(
         eq(otelSpans.projectId, projectId),
         gte(otelSpans.startedAt, window.since),
         lt(otelSpans.startedAt, window.until),
       )}
    ),
    ${sql.identifier(repsAlias)} as materialized (
      select distinct on (${otelSpans.traceId})
             ${otelSpans.traceId} as ${traceId},
             ${otelSpans.startedAt} as ${startedAt}
        from ${otelSpans}
        inner join ${sql.identifier(candidateAlias)}
          on ${sql.identifier(candidateAlias)}.${traceId} = ${otelSpans.traceId}
       where ${eq(otelSpans.projectId, projectId)}
       order by ${otelSpans.traceId} asc,
                (${otelSpans.parentSpanId} is null) desc,
                ${otelSpans.startedAt} asc,
                ${otelSpans.spanId} asc
    )
    select ${sql.identifier(repsAlias)}.${traceId},
           ${sql.identifier(repsAlias)}.${startedAt}
      from ${sql.identifier(repsAlias)}
     where ${sql.identifier(repsAlias)}.${startedAt} >= ${window.since}
       and ${sql.identifier(repsAlias)}.${startedAt} < ${window.until}
  `;

  return new Proxy(
    new Subquery(query, fields, selectedAlias),
    new SelectionProxyHandler({
      alias: selectedAlias,
      sqlAliasedBehavior: "alias",
      sqlBehavior: "error",
    }),
  ) as SubqueryWithSelection<typeof fields, string>;
}

function dateValue(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
