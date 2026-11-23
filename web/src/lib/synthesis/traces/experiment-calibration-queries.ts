import { and, asc, desc, eq, gte, inArray, isNotNull, lt, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { otelLogs, otelSpans } from "@/lib/ingest/otlp/schema";
import { getDb } from "@/lib/platform/db/client";
import type {
  ArmPairAgreementSummary,
  ComparisonFacet,
  ComparisonFilterSelection,
  ExperimentComparisonCount,
  JaccardByK,
  RankingComparisonRow,
  SelectionDetail,
} from "@/lib/synthesis/experiments/calibration-types";
import type { ExperimentWindow } from "@/lib/synthesis/experiments/service";

export type ExperimentCalibrationQueriesDb = Pick<ReturnType<typeof getDb>, "select">;

/** `listComparedQueries` runs a raw aggregate, so it needs `execute`. */
export type ComparedQueriesDb = Pick<ReturnType<typeof getDb>, "execute">;

export interface ListRankingComparisonsOptions {
  selection?: ComparisonFilterSelection;
  limit?: number;
  offset?: number;
}

const COMPARISON_EVENT = "ratel.experiment.comparison";
const RESULTS_EVENT = "ratel.experiment.results";
const SERVED_ARM_KEY = "ratel.experiment.served.arm";
const SHADOW_ARM_KEY = "ratel.experiment.shadow.arm";
const SERVED_OUTCOME_KEY = "ratel.experiment.served.outcome";
const SHADOW_OUTCOME_KEY = "ratel.experiment.shadow.outcome";
const SERVED_DURATION_MS_KEY = "ratel.experiment.served.duration_ms";
const SHADOW_DURATION_MS_KEY = "ratel.experiment.shadow.duration_ms";
const SERVED_HIT_COUNT_KEY = "ratel.experiment.served.hit_count";
const SHADOW_HIT_COUNT_KEY = "ratel.experiment.shadow.hit_count";
const ERROR_OUTCOMES = ["error", "timeout"] as const;
const TOP1_KEY = "ratel.experiment.agreement.top1";
const EXACT_ORDER_KEY = "ratel.experiment.agreement.exact_order";
const OVERLAP_COUNT_KEY = "ratel.experiment.agreement.overlap_count";
const JACCARD_KEY = "ratel.experiment.agreement.jaccard_at_k";
const AGREEMENT_K_KEY = "ratel.experiment.agreement.k";
const QUERY_KEY = "ratel.experiment.query";
const RESULT_IDS_KEY = "ratel.experiment.result_ids";
const RESULT_SCORES_KEY = "ratel.experiment.result_scores";
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
/** No selection means no filtering: the caller asked for the whole window. */
const DEFAULT_SELECTION: ComparisonFilterSelection = {
  scope: "all",
  facets: [],
  match: "any",
};
// grouping(agreementK, servedOutcome, shadowOutcome) bitmask per grouping set.
const PAIR_GRAIN = 0b111;
const K_GRAIN = 0b011;
const SERVED_OUTCOME_GRAIN = 0b101;
const SHADOW_OUTCOME_GRAIN = 0b110;

/** Count comparison records per experiment (ranking-shadow kind detection). */
export async function countExperimentComparisons(
  projectId: string,
  experimentNames: string[],
  window: ExperimentWindow,
  db: ExperimentCalibrationQueriesDb = getDb(),
): Promise<ExperimentComparisonCount[]> {
  if (experimentNames.length === 0) return [];
  const rows = await db
    .select({
      experimentName: otelLogs.experimentName,
      comparisonCount: sql<number>`count(*)::int`,
      mismatchCount: sql<number>`count(*) filter (where ${booleanAttr(EXACT_ORDER_KEY)} = false)::int`,
    })
    .from(otelLogs)
    .where(
      and(
        eq(otelLogs.projectId, projectId),
        inArray(otelLogs.experimentName, experimentNames),
        eq(otelLogs.eventName, COMPARISON_EVENT),
        gte(otelLogs.occurredAt, window.since),
        lt(otelLogs.occurredAt, window.until),
      ),
    )
    .groupBy(otelLogs.experimentName)
    .orderBy(asc(otelLogs.experimentName));

  return rows.map((row) => ({
    experimentName: row.experimentName!,
    comparisonCount: row.comparisonCount,
    mismatchCount: row.mismatchCount,
  }));
}

/**
 * Aggregate comparison agreement per (servedArm, shadowArm) direction.
 *
 * One window scan: `GROUPING SETS` computes the pair grain, the per-k jaccard
 * buckets, and both outcome distributions together — comparison records are a
 * census (one per shadow-tested request), so re-scanning the window once per
 * grain would multiply the page's dominant query cost at high volume.
 */
export async function getRankingComparisonSummary(
  projectId: string,
  experimentName: string,
  window: ExperimentWindow,
  db: ExperimentCalibrationQueriesDb = getDb(),
): Promise<ArmPairAgreementSummary[]> {
  const pairs = comparisonPairRows(projectId, experimentName, window, db);
  const bothArms = and(isNotNull(pairs.servedArm), isNotNull(pairs.shadowArm));
  // GROUPING() bit per extra column: 1 = rolled up in this set. The pair grain
  // rolls up all three (0b111), the k grain keeps agreementK (0b011), the
  // outcome grains keep servedOutcome (0b101) or shadowOutcome (0b110).
  const grouping = sql<number>`grouping(${pairs.agreementK}, ${pairs.servedOutcome}, ${pairs.shadowOutcome})::int`;
  const rows = await db
    .select({
      servedArm: pairs.servedArm,
      shadowArm: pairs.shadowArm,
      grain: grouping,
      agreementK: sql<number | null>`(${pairs.agreementK})::int`,
      servedOutcome: sql<string | null>`${pairs.servedOutcome}`,
      shadowOutcome: sql<string | null>`${pairs.shadowOutcome}`,
      comparisonCount: sql<number>`count(*)::int`,
      mismatchCount: sql<number>`count(*) filter (where ${pairs.exactOrder} = false)::int`,
      top1Rate: booleanRate(pairs.top1),
      exactOrderRate: booleanRate(pairs.exactOrder),
      averageJaccardAtK: sql<number | null>`avg(${pairs.jaccardAtK})::float8`,
      jaccardCount: sql<number>`count(${pairs.jaccardAtK})::int`,
      servedOutcomeCount: sql<number>`count(${pairs.servedOutcome})::int`,
      servedErrorCount: errorOutcomeCount(pairs.servedOutcome),
      servedAverageDurationMs: sql<number | null>`avg(${pairs.servedDurationMs})::float8`,
      servedP50DurationMs: percentile(0.5, pairs.servedDurationMs),
      servedP95DurationMs: percentile(0.95, pairs.servedDurationMs),
      shadowOutcomeCount: sql<number>`count(${pairs.shadowOutcome})::int`,
      shadowErrorCount: errorOutcomeCount(pairs.shadowOutcome),
      shadowAverageDurationMs: sql<number | null>`avg(${pairs.shadowDurationMs})::float8`,
      shadowP50DurationMs: percentile(0.5, pairs.shadowDurationMs),
      shadowP95DurationMs: percentile(0.95, pairs.shadowDurationMs),
    })
    .from(pairs)
    .where(bothArms)
    .groupBy(
      sql`${pairs.servedArm}, ${pairs.shadowArm}, grouping sets ((), (${pairs.agreementK}), (${pairs.servedOutcome}), (${pairs.shadowOutcome}))`,
    )
    .orderBy(asc(pairs.servedArm), asc(pairs.shadowArm), sql`(${pairs.agreementK})::int`);

  const jaccardByPair = new Map<string, JaccardByK[]>();
  const servedOutcomesByPair = new Map<string, Record<string, number>>();
  const shadowOutcomesByPair = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const key = pairKey(row.servedArm!, row.shadowArm!);
    if (row.grain === K_GRAIN) {
      // Bucket count matches the pre-consolidation semantics: rows where both
      // k and jaccard are number-typed.
      if (row.agreementK === null || row.jaccardCount === 0) continue;
      const buckets = jaccardByPair.get(key) ?? [];
      buckets.push({
        k: row.agreementK,
        count: row.jaccardCount,
        mean: row.averageJaccardAtK!,
      });
      jaccardByPair.set(key, buckets);
    } else if (row.grain === SERVED_OUTCOME_GRAIN) {
      if (row.servedOutcome === null) continue;
      const outcomes = servedOutcomesByPair.get(key) ?? {};
      outcomes[row.servedOutcome] = row.comparisonCount;
      servedOutcomesByPair.set(key, outcomes);
    } else if (row.grain === SHADOW_OUTCOME_GRAIN) {
      if (row.shadowOutcome === null) continue;
      const outcomes = shadowOutcomesByPair.get(key) ?? {};
      outcomes[row.shadowOutcome] = row.comparisonCount;
      shadowOutcomesByPair.set(key, outcomes);
    }
  }

  return rows
    .filter((row) => row.grain === PAIR_GRAIN)
    .map((row) => {
      const key = pairKey(row.servedArm!, row.shadowArm!);
      return {
        servedArm: row.servedArm!,
        shadowArm: row.shadowArm!,
        comparisonCount: row.comparisonCount,
        mismatchCount: row.mismatchCount,
        top1Rate: row.top1Rate,
        exactOrderRate: row.exactOrderRate,
        averageJaccardAtK: row.averageJaccardAtK,
        jaccardByK: jaccardByPair.get(key) ?? [],
        served: {
          outcomes: servedOutcomesByPair.get(key) ?? {},
          errorRate:
            row.servedOutcomeCount === 0 ? null : row.servedErrorCount / row.servedOutcomeCount,
          averageDurationMs: row.servedAverageDurationMs,
          p50DurationMs: row.servedP50DurationMs,
          p95DurationMs: row.servedP95DurationMs,
        },
        shadow: {
          outcomes: shadowOutcomesByPair.get(key) ?? {},
          errorRate:
            row.shadowOutcomeCount === 0 ? null : row.shadowErrorCount / row.shadowOutcomeCount,
          averageDurationMs: row.shadowAverageDurationMs,
          p50DurationMs: row.shadowP50DurationMs,
          p95DurationMs: row.shadowP95DurationMs,
        },
      };
    });
}

/** Count one filtered comparison-browser result set. */
export async function countRankingComparisons(
  projectId: string,
  experimentName: string,
  window: ExperimentWindow,
  opts: ListRankingComparisonsOptions,
  db: ExperimentCalibrationQueriesDb = getDb(),
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(otelLogs)
    .where(rankingComparisonWhere(projectId, experimentName, window, opts));
  return rows[0]?.count ?? 0;
}

/** Newest-first comparison rows joined with both arms' ranked results. */
export async function listRankingComparisons(
  projectId: string,
  experimentName: string,
  window: ExperimentWindow,
  opts: ListRankingComparisonsOptions,
  db: ExperimentCalibrationQueriesDb = getDb(),
): Promise<RankingComparisonRow[]> {
  const limit = Math.min(opts.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const offset = Math.max(opts.offset ?? 0, 0);
  const rows = await db
    .select({
      selectionId: otelLogs.experimentSelectionId,
      occurredAt: otelLogs.occurredAt,
      traceId: otelLogs.traceId,
      query: stringAttr(QUERY_KEY),
      servedArm: servedArmColumn(),
      shadowArm: shadowArmColumn(),
      servedOutcome: stringAttr(SERVED_OUTCOME_KEY),
      shadowOutcome: stringAttr(SHADOW_OUTCOME_KEY),
      servedDurationMs: numberAttr(SERVED_DURATION_MS_KEY),
      shadowDurationMs: numberAttr(SHADOW_DURATION_MS_KEY),
      servedHitCount: numberAttr(SERVED_HIT_COUNT_KEY),
      shadowHitCount: numberAttr(SHADOW_HIT_COUNT_KEY),
      top1: booleanAttr(TOP1_KEY),
      exactOrder: booleanAttr(EXACT_ORDER_KEY),
      overlapCount: numberAttr(OVERLAP_COUNT_KEY),
      jaccardAtK: numberAttr(JACCARD_KEY),
      agreementK: numberAttr(AGREEMENT_K_KEY),
    })
    .from(otelLogs)
    .where(rankingComparisonWhere(projectId, experimentName, window, opts))
    .orderBy(desc(otelLogs.occurredAt), desc(otelLogs.id))
    .limit(limit)
    .offset(offset);

  const results = await selectionResults(
    projectId,
    rows.map((row) => row.selectionId).filter((id): id is string => id !== null),
    db,
  );

  return rows.map((row) => {
    const served = armResults(results, row.selectionId, row.servedArm);
    const shadow = armResults(results, row.selectionId, row.shadowArm);
    return {
      selectionId: row.selectionId,
      occurredAt: row.occurredAt,
      traceId: row.traceId,
      query: row.query,
      servedArm: row.servedArm,
      shadowArm: row.shadowArm,
      servedOutcome: row.servedOutcome,
      shadowOutcome: row.shadowOutcome,
      servedDurationMs: row.servedDurationMs,
      shadowDurationMs: row.shadowDurationMs,
      servedHitCount: row.servedHitCount,
      shadowHitCount: row.shadowHitCount,
      top1: row.top1,
      exactOrder: row.exactOrder,
      overlapCount: row.overlapCount,
      jaccardAtK: row.jaccardAtK,
      agreementK: row.agreementK,
      servedResultIds: served?.ids ?? null,
      shadowResultIds: shadow?.ids ?? null,
      servedResultScores: served?.scores ?? null,
      shadowResultScores: shadow?.scores ?? null,
    };
  });
}

function rankingComparisonWhere(
  projectId: string,
  experimentName: string,
  window: ExperimentWindow,
  opts: ListRankingComparisonsOptions,
): SQL {
  return and(
    eq(otelLogs.projectId, projectId),
    eq(otelLogs.experimentName, experimentName),
    eq(otelLogs.eventName, COMPARISON_EVENT),
    gte(otelLogs.occurredAt, window.since),
    lt(otelLogs.occurredAt, window.until),
    rankingComparisonFilter(opts.selection ?? DEFAULT_SELECTION),
  )!;
}

/**
 * Scope (`mismatch` | `all`) narrowed by independent facets. Facets overlap by
 * design — a comparison that drops a tool *and* reorders the rest matches both
 * — and combine with OR (`any`) or AND (`all`).
 */
function rankingComparisonFilter(selection: ComparisonFilterSelection): SQL {
  const scope =
    selection.scope === "all" ? sql`true` : sql`${booleanAttr(EXACT_ORDER_KEY)} = false`;
  if (selection.facets.length === 0) return scope;
  const facets = sql.join(
    selection.facets.map(comparisonFacetFilter),
    selection.match === "all" ? sql` and ` : sql` or `,
  );
  return sql`${scope} and (${facets})`;
}

function comparisonFacetFilter(facet: ComparisonFacet): SQL {
  const servedHitCount = numberAttr(SERVED_HIT_COUNT_KEY);
  const shadowHitCount = numberAttr(SHADOW_HIT_COUNT_KEY);
  const overlapCount = numberAttr(OVERLAP_COUNT_KEY);

  switch (facet) {
    case "top1":
      return sql`${booleanAttr(TOP1_KEY)} = false`;
    case "order":
      return reorderedFilter();
    case "missing":
      return sql`${servedHitCount} > ${overlapCount}`;
    case "added":
      return sql`${shadowHitCount} > ${overlapCount}`;
    case "outcome":
      return sql`${stringAttr(SERVED_OUTCOME_KEY)} is distinct from ${stringAttr(SHADOW_OUTCOME_KEY)}`;
  }
}

/**
 * A comparison is reordered when a result both arms returned sits at a
 * different rank — the same rule the row's `moved` diff chip uses, so the
 * filter and the table can't disagree. Rank data lives on the per-arm
 * `results` records, hence the selection-keyed correlated lookup
 * (otel_logs_project_selection_idx). PostgreSQL may evaluate that lookup before
 * other quals, and the count query must consider every candidate row. The
 * second branch covers selections whose rankings were never exported: equal
 * hit counts on both sides plus a flagged mismatch can only mean a reorder.
 */
function reorderedFilter(): SQL {
  const servedResults = alias(otelLogs, "served_results");
  const shadowResults = alias(otelLogs, "shadow_results");
  const servedIds = sql`${servedResults.experimentAttrs} -> ${RESULT_IDS_KEY}`;
  const shadowIds = sql`${shadowResults.experimentAttrs} -> ${RESULT_IDS_KEY}`;
  const shadowRank = sql`array_position(
    array(select jsonb_array_elements_text(${shadowIds})),
    served_entry.result_id
  )`;
  const servedHitCount = numberAttr(SERVED_HIT_COUNT_KEY);
  const shadowHitCount = numberAttr(SHADOW_HIT_COUNT_KEY);
  const overlapCount = numberAttr(OVERLAP_COUNT_KEY);

  return sql`(
    exists (
      select 1
      from ${otelLogs} served_results
      join ${otelLogs} shadow_results
        on ${shadowResults.projectId} = ${servedResults.projectId}
       and ${shadowResults.experimentSelectionId} = ${servedResults.experimentSelectionId}
       and ${shadowResults.eventName} = ${RESULTS_EVENT}
       and ${shadowResults.experimentArm} = ${shadowArmColumn()}
      where ${servedResults.projectId} = ${otelLogs.projectId}
        and ${servedResults.experimentSelectionId} = ${otelLogs.experimentSelectionId}
        and ${servedResults.eventName} = ${RESULTS_EVENT}
        and ${servedResults.experimentArm} = ${servedArmColumn()}
        and jsonb_typeof(${servedIds}) = 'array'
        and jsonb_typeof(${shadowIds}) = 'array'
        and exists (
          select 1
          from jsonb_array_elements_text(${servedIds})
            with ordinality as served_entry(result_id, served_rank)
          where ${shadowRank} is not null
            and ${shadowRank} <> served_entry.served_rank
        )
    )
    or (
      ${booleanAttr(EXACT_ORDER_KEY)} = false
      and ${servedHitCount} = ${overlapCount}
      and ${shadowHitCount} = ${overlapCount}
    )
  )`;
}

/** Every log record of one selection, plus a sampled-trace probe. */
export async function getSelectionDetail(
  projectId: string,
  selectionId: string,
  db: ExperimentCalibrationQueriesDb = getDb(),
): Promise<SelectionDetail | null> {
  const rows = await db
    .select({
      id: otelLogs.id,
      eventName: otelLogs.eventName,
      occurredAt: otelLogs.occurredAt,
      traceId: otelLogs.traceId,
      arm: otelLogs.experimentArm,
      role: otelLogs.experimentRole,
      experimentName: otelLogs.experimentName,
      experimentAttrs: otelLogs.experimentAttrs,
    })
    .from(otelLogs)
    .where(and(eq(otelLogs.projectId, projectId), eq(otelLogs.experimentSelectionId, selectionId)))
    .orderBy(asc(otelLogs.occurredAt), asc(otelLogs.eventName));
  if (rows.length === 0) return null;

  const traceId = rows.find((row) => row.traceId !== null)?.traceId ?? null;
  return {
    selectionId,
    experimentName: rows.find((row) => row.experimentName !== null)?.experimentName ?? null,
    records: rows.map((row) => ({
      id: row.id,
      eventName: row.eventName,
      occurredAt: row.occurredAt,
      traceId: row.traceId,
      arm: row.arm,
      role: row.role,
      experimentAttrs: row.experimentAttrs,
    })),
    traceId,
    traceHasSpans: traceId === null ? false : await traceHasSpans(projectId, traceId, db),
  };
}

/**
 * Typed projection of one comparison record per row. Arms are guarded jsonb
 * strings; the shadow arm falls back to the promoted `experiment_arm` column
 * because the SDK attributes comparison records to the shadow arm.
 */
function comparisonPairRows(
  projectId: string,
  experimentName: string,
  window: ExperimentWindow,
  db: ExperimentCalibrationQueriesDb,
) {
  return db
    .select({
      servedArm: servedArmColumn().as("served_arm"),
      shadowArm: shadowArmColumn().as("shadow_arm"),
      top1: booleanAttr(TOP1_KEY).as("agreement_top1"),
      exactOrder: booleanAttr(EXACT_ORDER_KEY).as("agreement_exact_order"),
      jaccardAtK: numberAttr(JACCARD_KEY).as("agreement_jaccard_at_k"),
      agreementK: numberAttr(AGREEMENT_K_KEY).as("agreement_k"),
      servedOutcome: stringAttr(SERVED_OUTCOME_KEY).as("served_outcome"),
      shadowOutcome: stringAttr(SHADOW_OUTCOME_KEY).as("shadow_outcome"),
      servedDurationMs: numberAttr(SERVED_DURATION_MS_KEY).as("served_duration_ms"),
      shadowDurationMs: numberAttr(SHADOW_DURATION_MS_KEY).as("shadow_duration_ms"),
    })
    .from(otelLogs)
    .where(
      and(
        eq(otelLogs.projectId, projectId),
        eq(otelLogs.experimentName, experimentName),
        eq(otelLogs.eventName, COMPARISON_EVENT),
        gte(otelLogs.occurredAt, window.since),
        lt(otelLogs.occurredAt, window.until),
      ),
    )
    .as("calibration_comparison_pairs");
}

type ComparisonPairRows = ReturnType<typeof comparisonPairRows>;
type PairOutcomeColumn = ComparisonPairRows["servedOutcome"] | ComparisonPairRows["shadowOutcome"];

function errorOutcomeCount(outcome: PairOutcomeColumn) {
  return sql<number>`count(*) filter (where ${inArray(outcome, [...ERROR_OUTCOMES])})::int`;
}

function percentile(fraction: number, column: SQL.Aliased<number | null>) {
  return sql<number | null>`(percentile_cont(${sql.raw(
    String(fraction),
  )}) within group (order by ${column}))::float8`;
}

function pairKey(servedArm: string, shadowArm: string): string {
  return `${servedArm}\u0000${shadowArm}`;
}

function booleanRate(column: SQL<boolean | null> | SQL.Aliased<boolean | null>) {
  return sql<number | null>`avg(case
    when ${column} then 1
    when not ${column} then 0
  end)::float8`;
}

interface SelectionArmResults {
  ids: string[] | null;
  scores: number[] | null;
}

/**
 * Fetch results records for the listed selections in a second, selection-keyed
 * query (otel_logs_project_selection_idx) so the join can't multiply comparison
 * rows. Deliberately not window-bounded: results land near the comparison but
 * may fall outside the queried window.
 */
async function selectionResults(
  projectId: string,
  selectionIds: string[],
  db: ExperimentCalibrationQueriesDb,
): Promise<Map<string, SelectionArmResults>> {
  const results = new Map<string, SelectionArmResults>();
  if (selectionIds.length === 0) return results;
  const rows = await db
    .select({
      selectionId: otelLogs.experimentSelectionId,
      arm: otelLogs.experimentArm,
      experimentAttrs: otelLogs.experimentAttrs,
    })
    .from(otelLogs)
    .where(
      and(
        eq(otelLogs.projectId, projectId),
        inArray(otelLogs.experimentSelectionId, [...new Set(selectionIds)]),
        eq(otelLogs.eventName, RESULTS_EVENT),
      ),
    )
    .orderBy(asc(otelLogs.occurredAt), asc(otelLogs.id));

  for (const row of rows) {
    if (row.selectionId === null || row.arm === null) continue;
    const key = pairKey(row.selectionId, row.arm);
    if (results.has(key)) continue;
    results.set(key, {
      ids: stringArrayFrom(row.experimentAttrs[RESULT_IDS_KEY]),
      scores: numberArrayFrom(row.experimentAttrs[RESULT_SCORES_KEY]),
    });
  }
  return results;
}

function armResults(
  results: Map<string, SelectionArmResults>,
  selectionId: string | null,
  arm: string | null,
): SelectionArmResults | undefined {
  if (selectionId === null || arm === null) return undefined;
  return results.get(pairKey(selectionId, arm));
}

function stringArrayFrom(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((element): element is string => typeof element === "string");
}

function numberArrayFrom(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter(
    (element): element is number => typeof element === "number" && Number.isFinite(element),
  );
}

async function traceHasSpans(
  projectId: string,
  traceId: string,
  db: ExperimentCalibrationQueriesDb,
): Promise<boolean> {
  const [row] = await db
    .select({ found: sql<boolean>`true` })
    .from(otelSpans)
    .where(and(eq(otelSpans.projectId, projectId), eq(otelSpans.traceId, traceId)))
    .limit(1);
  return row !== undefined;
}

function servedArmColumn() {
  return sql<string | null>`nullif(btrim(${stringAttr(SERVED_ARM_KEY)}), '')`;
}

/** Comparison records are attributed to the shadow arm, hence the column fallback. */
function shadowArmColumn() {
  return sql<string | null>`coalesce(
    nullif(btrim(${stringAttr(SHADOW_ARM_KEY)}), ''),
    nullif(btrim(${otelLogs.experimentArm}), '')
  )`;
}

function stringAttr(key: string) {
  return sql<string | null>`case
    when jsonb_typeof(${otelLogs.experimentAttrs} -> ${key}) = 'string'
    then ${otelLogs.experimentAttrs} ->> ${key}
  end`;
}

function numberAttr(key: string) {
  return sql<number | null>`case
    when jsonb_typeof(${otelLogs.experimentAttrs} -> ${key}) = 'number'
    then (${otelLogs.experimentAttrs} ->> ${key})::float8
  end`;
}

function booleanAttr(key: string) {
  return sql<boolean | null>`case
    when jsonb_typeof(${otelLogs.experimentAttrs} -> ${key}) = 'boolean'
    then (${otelLogs.experimentAttrs} ->> ${key})::boolean
  end`;
}

/** One query the arms were compared on, with how often they disagreed. */
export interface ComparedQuery {
  query: string;
  comparisons: number;
  mismatches: number;
  lastSeenAt: Date;
  /**
   * The most recent selection where the arms actually DISAGREED on this query,
   * so a picker offering it as "the arms disagreed on this" can open the same
   * view the Calibration mismatch browser opens. Null when every comparison of
   * this query agreed. Recorded as a pair: a selection id is only resolvable
   * within its experiment.
   */
  mismatchSelectionId: string | null;
  mismatchExperimentName: string | null;
}

/**
 * The queries a project's shadow experiments were actually compared on, worst
 * first (most disagreements, then most traffic).
 *
 * Powers the Playground's prompt picker. Deliberately NOT scoped to one
 * experiment: someone debugging a description wants the queries their agents
 * really send, and which experiment happened to surface a disagreement is
 * incidental to that.
 */
export async function listComparedQueries(
  projectId: string,
  window: ExperimentWindow,
  limit = 20,
  db: ComparedQueriesDb = getDb(),
): Promise<ComparedQuery[]> {
  // Written as one raw aggregate rather than through the query builder: the
  // builder renders the grouped expression qualified in GROUP BY but unqualified
  // in the projection, which Postgres rejects with 42803. Same approach as
  // `listObservedTools` in lib/catalogs/queries.ts, for the same reason.
  const result = await db.execute(sql`
    select
      ${otelLogs.experimentAttrs} ->> ${QUERY_KEY} as query,
      count(*)::int as comparisons,
      count(*) filter (
        where jsonb_typeof(${otelLogs.experimentAttrs} -> ${EXACT_ORDER_KEY}) = 'boolean'
          and (${otelLogs.experimentAttrs} ->> ${EXACT_ORDER_KEY})::boolean = false
      )::int as mismatches,
      max(${otelLogs.occurredAt}) as last_seen_at,
      -- The newest DISAGREEING selection, so the picker can hand the reader the
      -- same drill-down Calibration would. array_agg + filter rather than a
      -- lateral: the row is already in this aggregate's frame.
      (array_agg(${otelLogs.experimentSelectionId} order by ${otelLogs.occurredAt} desc)
        filter (
          where ${otelLogs.experimentSelectionId} is not null
            and jsonb_typeof(${otelLogs.experimentAttrs} -> ${EXACT_ORDER_KEY}) = 'boolean'
            and (${otelLogs.experimentAttrs} ->> ${EXACT_ORDER_KEY})::boolean = false
        ))[1] as mismatch_selection_id,
      (array_agg(${otelLogs.experimentName} order by ${otelLogs.occurredAt} desc)
        filter (
          where ${otelLogs.experimentSelectionId} is not null
            and ${otelLogs.experimentName} is not null
            and jsonb_typeof(${otelLogs.experimentAttrs} -> ${EXACT_ORDER_KEY}) = 'boolean'
            and (${otelLogs.experimentAttrs} ->> ${EXACT_ORDER_KEY})::boolean = false
        ))[1] as mismatch_experiment_name
    from ${otelLogs}
    where ${otelLogs.projectId} = ${projectId}
      and ${otelLogs.eventName} = ${COMPARISON_EVENT}
      and ${otelLogs.occurredAt} >= ${window.since}
      and ${otelLogs.occurredAt} < ${window.until}
      and jsonb_typeof(${otelLogs.experimentAttrs} -> ${QUERY_KEY}) = 'string'
    group by 1
    order by 3 desc, 2 desc, 1 asc
    limit ${limit}
  `);

  return result.rows.flatMap((row) => {
    const record = row as {
      query: string | null;
      comparisons: number;
      mismatches: number;
      last_seen_at: string | Date;
      mismatch_selection_id: string | null;
      mismatch_experiment_name: string | null;
    };
    if (record.query === null) return [];
    return [
      {
        query: record.query,
        comparisons: record.comparisons,
        mismatches: record.mismatches,
        lastSeenAt: new Date(record.last_seen_at),
        mismatchSelectionId: record.mismatch_selection_id ?? null,
        mismatchExperimentName: record.mismatch_experiment_name ?? null,
      },
    ];
  });
}
