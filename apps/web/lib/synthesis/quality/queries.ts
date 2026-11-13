import { and, asc, desc, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { otelLogs } from "@/lib/ingest/otlp/schema";
import { getDb } from "@/lib/platform/db/client";
import type { ExperimentWindow } from "@/lib/synthesis/experiments/service";
import { queryKey } from "@/lib/synthesis/match-quality/labels";
import { matchQualityLabels } from "@/lib/synthesis/match-quality/schema";
import {
  type ArmRanking,
  type AttributionMode,
  applyAnswerKey,
  type EvaluableSelection,
  type RecordedInvocationRank,
  resolveAttributionMode,
} from "@/lib/synthesis/quality/ground-truth";

/**
 * Reading the quality meter's population out of `otel_logs`.
 *
 * Three selection-keyed reads rather than one join, for the reason the
 * calibration queries already document: a comparison record is one row per
 * shadow-tested request, and joining the per-arm `results` records inline
 * multiplies it by the arm count. The reads are also deliberately ordered so the
 * comparison scan is the only window-bounded one. `results` and `invocation`
 * records land near their comparison but routinely fall a few seconds outside a
 * window boundary, and bounding them would silently drop the arms of every
 * search near the edge.
 */

export type QualityQueriesDb = Pick<ReturnType<typeof getDb>, "select">;

const COMPARISON_EVENT = "ratel.experiment.comparison";
const RESULTS_EVENT = "ratel.experiment.results";
const INVOCATION_EVENT = "ratel.experiment.invocation";
const SELECTION_EVENT = "ratel.experiment.selection";

const SERVED_ARM_KEY = "ratel.experiment.served.arm";
const SHADOW_ARM_KEY = "ratel.experiment.shadow.arm";
const SERVED_OUTCOME_KEY = "ratel.experiment.served.outcome";
const SHADOW_OUTCOME_KEY = "ratel.experiment.shadow.outcome";
const SERVED_DURATION_MS_KEY = "ratel.experiment.served.duration_ms";
const SHADOW_DURATION_MS_KEY = "ratel.experiment.shadow.duration_ms";
const AGREEMENT_K_KEY = "ratel.experiment.agreement.k";
const QUERY_KEY = "ratel.experiment.query";
const RESULT_IDS_KEY = "ratel.experiment.result_ids";
const RESULT_SCORES_KEY = "ratel.experiment.result_scores";
const INVOCATION_ATTRIBUTED_KEY = "ratel.experiment.invocation.attributed";
const INVOCATION_RANK_KEY = "ratel.experiment.invocation.rank";
const EFFECTIVE_ARM_KEY = "ratel.experiment.effective_arm";

/**
 * Where the invoked tool's id might be, most specific first.
 *
 * The SDK's invocation record is not pinned by anything in this repo, because
 * Cloud is a consumer of that vocabulary rather than its owner. So instead of
 * hard-coding one
 * key and silently reporting `n = 0` when it moves, we probe a short list across
 * both the projected `ratel.experiment.*` bag and the raw attributes, and report
 * which key answered. {@link QualitySelectionDiagnostics} carries that out to
 * the page, so a vocabulary change shows up as a labelled gap instead of an
 * empty chart.
 */
const INVOKED_TOOL_KEYS = [
  "ratel.experiment.invocation.tool_id",
  "ratel.experiment.invocation.tool",
  "ratel.experiment.invocation.id",
  "ratel.experiment.invocation.capability_id",
  "ratel.tool.id",
  "ratel.catalog.id",
  "gen_ai.tool.name",
] as const;

/**
 * How many shadow-tested searches one page will read.
 *
 * The meter is a rate, not a ledger, so it does not need every row: at this cap
 * a containment figure is already precise to well under a point, and the cap is
 * what keeps the page's cost flat as a partner's traffic grows. When it binds,
 * the newest selections win and {@link QualitySelectionDiagnostics.truncated}
 * says so rather than quietly reporting a partial window as a whole one.
 */
export const MAX_SELECTIONS = 5000;

export interface QualitySelectionDiagnostics {
  /**
   * Comparison records in the window, before the cap.
   *
   * Counted separately when {@link truncated}, because the scan only fetches
   * `limit + 1` rows and so cannot see past its own cap. The surfaces print
   * this as "how many searches we ran alongside yours", which is a fact about
   * the window rather than about how many of them we sampled, so quietly
   * reporting the cap here would understate a busy partner's traffic.
   */
  comparisonCount: number;
  /** Selections actually loaded. */
  selectionCount: number;
  /** Selections that carry an attributed invocation naming a tool. */
  invocationCount: number;
  /** Selections whose invocation recorded a rank but not a tool identity. */
  recordedRankCount: number;
  /** Which attribution the revealed tier is running on. */
  attributionMode: AttributionMode;
  /** Selections for which at least one arm exported a ranked list. */
  rankedSelectionCount: number;
  /** Which key the invoked tool id was found under, or null when none was. */
  invokedToolKey: string | null;
  truncated: boolean;
}

export interface QualitySelections {
  selections: EvaluableSelection[];
  diagnostics: QualitySelectionDiagnostics;
}

/**
 * The selections with the project's answer key attached.
 *
 * One read per load, keyed on the normalized query exactly as `labels.ts` keys
 * it. An `unclear` row marks the request as read-and-undecided; a missing row
 * means nobody has read it yet. Either way the selection carries no answer and
 * the scorers leave it out, which is the whole contract: never a guess.
 */
export async function withAnswers(
  projectId: string,
  selections: EvaluableSelection[],
  db: QualityQueriesDb,
): Promise<EvaluableSelection[]> {
  if (selections.length === 0) return selections;
  const rows = await db
    .select({
      queryKey: matchQualityLabels.queryKey,
      entryId: matchQualityLabels.entryId,
      source: matchQualityLabels.source,
    })
    .from(matchQualityLabels)
    .where(eq(matchQualityLabels.projectId, projectId));
  return applyAnswerKey(selections, new Map(rows.map((row) => [row.queryKey, row])), queryKey);
}

/** Load one calibration's shadow-tested searches, with both arms' rankings. */
export async function loadEvaluableSelections(
  projectId: string,
  experimentName: string,
  window: ExperimentWindow,
  db: QualityQueriesDb = getDb(),
  limit: number = MAX_SELECTIONS,
): Promise<QualitySelections> {
  const comparisons = await db
    .select({
      selectionId: otelLogs.experimentSelectionId,
      occurredAt: otelLogs.occurredAt,
      query: stringAttr(QUERY_KEY),
      servedArm: servedArmColumn(),
      shadowArm: shadowArmColumn(),
      servedOutcome: stringAttr(SERVED_OUTCOME_KEY),
      shadowOutcome: stringAttr(SHADOW_OUTCOME_KEY),
      servedDurationMs: numberAttr(SERVED_DURATION_MS_KEY),
      shadowDurationMs: numberAttr(SHADOW_DURATION_MS_KEY),
      agreementK: numberAttr(AGREEMENT_K_KEY),
    })
    .from(otelLogs)
    .where(
      and(
        eq(otelLogs.projectId, projectId),
        eq(otelLogs.experimentName, experimentName),
        eq(otelLogs.eventName, COMPARISON_EVENT),
        isNotNull(otelLogs.experimentSelectionId),
        gte(otelLogs.occurredAt, window.since),
        lt(otelLogs.occurredAt, window.until),
      ),
    )
    // Newest first so a bound cap keeps the most recent window, then oldest-first
    // again below: the trend chart and the daily rollup both read left to right.
    .orderBy(desc(otelLogs.occurredAt), desc(otelLogs.id))
    .limit(limit + 1);

  const truncated = comparisons.length > limit;
  const kept = truncated ? comparisons.slice(0, limit) : comparisons;
  const selectionIds = [
    ...new Set(kept.map((row) => row.selectionId).filter((id): id is string => id !== null)),
  ];

  const [results, invocations, comparisonCount] = await Promise.all([
    selectionResults(projectId, selectionIds, db),
    selectionInvocations(projectId, selectionIds, db),
    // Only when the cap actually bound: an unbounded window already knows its
    // own total, and counting it again would put a second full scan on every
    // page load to learn a number we are holding.
    truncated
      ? countComparisons(projectId, experimentName, window, db)
      : Promise.resolve(kept.length),
  ]);

  let invocationCount = 0;
  let recordedRankCount = 0;
  let rankedSelectionCount = 0;
  const selections: EvaluableSelection[] = [];
  for (const row of kept) {
    if (row.selectionId === null) continue;
    const arms = buildArms(row, results.get(row.selectionId));
    if (arms.some((arm) => arm.resultIds.length > 0)) rankedSelectionCount += 1;
    const invokedToolId = invocations.tools.get(row.selectionId) ?? null;
    if (invokedToolId !== null) invocationCount += 1;
    const invokedRank = invocations.ranks.get(row.selectionId) ?? null;
    if (invokedRank !== null) recordedRankCount += 1;
    selections.push({
      selectionId: row.selectionId,
      occurredAt: toDate(row.occurredAt),
      query: row.query,
      arms,
      invokedToolId,
      invokedRank,
    });
  }
  selections.reverse();
  const answered = await withAnswers(projectId, selections, db);

  return {
    selections: answered,
    diagnostics: {
      comparisonCount,
      selectionCount: selections.length,
      invocationCount,
      recordedRankCount,
      attributionMode: resolveAttributionMode({
        toolIds: invocationCount,
        recordedRanks: recordedRankCount,
      }),
      rankedSelectionCount,
      invokedToolKey: invocations.key,
      truncated,
    },
  };
}

/**
 * How many comparisons the window actually holds, cap ignored.
 *
 * Deliberately the same predicate as the scan above, so the two can never
 * disagree about what "in the window" means.
 */
async function countComparisons(
  projectId: string,
  experimentName: string,
  window: ExperimentWindow,
  db: QualityQueriesDb,
): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(otelLogs)
    .where(
      and(
        eq(otelLogs.projectId, projectId),
        eq(otelLogs.experimentName, experimentName),
        eq(otelLogs.eventName, COMPARISON_EVENT),
        isNotNull(otelLogs.experimentSelectionId),
        gte(otelLogs.occurredAt, window.since),
        lt(otelLogs.occurredAt, window.until),
      ),
    );
  return row?.total ?? 0;
}

type ComparisonRow = {
  selectionId: string | null;
  occurredAt: Date | string;
  query: string | null;
  servedArm: string | null;
  shadowArm: string | null;
  servedOutcome: string | null;
  shadowOutcome: string | null;
  servedDurationMs: number | null;
  shadowDurationMs: number | null;
  agreementK: number | null;
};

/**
 * Turn one comparison row plus its results records into per-arm rankings.
 *
 * An arm named on the comparison but missing a results record still gets an
 * entry, with an empty list. Omitting it would quietly shrink `n` for that arm
 * alone, so two arms on the same screen would be scored over different
 * populations, which is the one failure mode that makes a head-to-head number
 * a lie.
 */
function buildArms(
  row: ComparisonRow,
  byArm: Map<string, SelectionArmResults> | undefined,
): ArmRanking[] {
  const arms: ArmRanking[] = [];
  const add = (
    arm: string | null,
    role: "serving" | "shadow",
    durationMs: number | null,
    outcome: string | null,
  ) => {
    if (arm === null || arms.some((existing) => existing.arm === arm)) return;
    const recorded = byArm?.get(arm);
    arms.push({
      arm,
      role,
      resultIds: recorded?.ids ?? [],
      resultScores: recorded?.scores ?? null,
      requestedK: row.agreementK,
      durationMs,
      outcome,
    });
  };
  add(row.servedArm, "serving", row.servedDurationMs, row.servedOutcome);
  add(row.shadowArm, "shadow", row.shadowDurationMs, row.shadowOutcome);
  return arms;
}

interface SelectionArmResults {
  ids: string[];
  scores: number[] | null;
}

/**
 * The per-arm ranked lists for these selections.
 *
 * Not window-bounded, and keyed on `otel_logs_project_selection_idx`. The first
 * record per (selection, arm) wins: a retried export can land twice, and the
 * later copy is the duplicate, not a correction.
 */
async function selectionResults(
  projectId: string,
  selectionIds: string[],
  db: QualityQueriesDb,
): Promise<Map<string, Map<string, SelectionArmResults>>> {
  const bySelection = new Map<string, Map<string, SelectionArmResults>>();
  if (selectionIds.length === 0) return bySelection;

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
        inArray(otelLogs.experimentSelectionId, selectionIds),
        eq(otelLogs.eventName, RESULTS_EVENT),
      ),
    )
    .orderBy(asc(otelLogs.occurredAt), asc(otelLogs.id));

  for (const row of rows) {
    if (row.selectionId === null || row.arm === null) continue;
    const arm = row.arm.trim();
    if (arm === "") continue;
    const arms = bySelection.get(row.selectionId) ?? new Map();
    if (arms.has(arm)) continue;
    arms.set(arm, {
      ids: stringArrayFrom(row.experimentAttrs[RESULT_IDS_KEY]),
      scores: numberArrayFrom(row.experimentAttrs[RESULT_SCORES_KEY]),
    });
    bySelection.set(row.selectionId, arms);
  }
  return bySelection;
}

interface SelectionInvocations {
  tools: Map<string, string>;
  ranks: Map<string, RecordedInvocationRank>;
  key: string | null;
}

/**
 * The tool the agent ran for each selection, and the key it was found under.
 *
 * Only ATTRIBUTED invocations count. An unattributed one is a tool call the SDK
 * could not tie back to this search, and treating it as the target would score
 * retrieval against something it was never asked for.
 */
async function selectionInvocations(
  projectId: string,
  selectionIds: string[],
  db: QualityQueriesDb,
): Promise<SelectionInvocations> {
  const tools = new Map<string, string>();
  const ranks = new Map<string, RecordedInvocationRank>();
  if (selectionIds.length === 0) return { tools, ranks, key: null };

  const rows = await db
    .select({
      selectionId: otelLogs.experimentSelectionId,
      attributed: sql<boolean | null>`case
        when jsonb_typeof(${otelLogs.experimentAttrs} -> ${INVOCATION_ATTRIBUTED_KEY}) = 'boolean'
        then (${otelLogs.experimentAttrs} ->> ${INVOCATION_ATTRIBUTED_KEY})::boolean
        else null
      end`,
      rank: sql<number | null>`case
        when jsonb_typeof(${otelLogs.experimentAttrs} -> ${INVOCATION_RANK_KEY}) = 'number'
        then (${otelLogs.experimentAttrs} ->> ${INVOCATION_RANK_KEY})::int
        else null
      end`,
      effectiveArm: sql<string | null>`coalesce(
        nullif(btrim(${otelLogs.experimentAttrs} ->> ${EFFECTIVE_ARM_KEY}), ''),
        nullif(btrim(${otelLogs.experimentArm}), '')
      )`,
      experimentAttrs: otelLogs.experimentAttrs,
      attributes: otelLogs.attributes,
    })
    .from(otelLogs)
    .where(
      and(
        eq(otelLogs.projectId, projectId),
        inArray(otelLogs.experimentSelectionId, selectionIds),
        eq(otelLogs.eventName, INVOCATION_EVENT),
      ),
    )
    .orderBy(asc(otelLogs.occurredAt), asc(otelLogs.id));

  let key: string | null = null;
  for (const row of rows) {
    if (row.selectionId === null) continue;
    // `null` means the SDK did not say either way, which older emitters do; a
    // record that explicitly says `false` is a tool call this search did not
    // cause, and must not become its target.
    if (row.attributed === false) continue;

    // The SDK records the position the invoked tool held in the serving arm's
    // list. `-1` is its sentinel for "the agent ran something that arm never
    // returned", which is a scored miss rather than missing data, so it maps to
    // a null rank rather than being dropped. Ranks are 0-based on the wire and
    // 1-based everywhere above this line.
    if (!ranks.has(row.selectionId) && row.effectiveArm !== null && row.rank !== null) {
      ranks.set(row.selectionId, {
        arm: row.effectiveArm,
        rank: row.rank < 0 ? null : row.rank + 1,
      });
    }

    if (tools.has(row.selectionId)) continue;
    const found = findInvokedTool(row.experimentAttrs, row.attributes);
    if (!found) continue;
    key ??= found.key;
    tools.set(row.selectionId, found.toolId);
  }
  return { tools, ranks, key };
}

function findInvokedTool(
  experimentAttrs: Record<string, unknown>,
  attributes: Record<string, unknown>,
): { key: string; toolId: string } | null {
  for (const key of INVOKED_TOOL_KEYS) {
    const value = experimentAttrs[key] ?? attributes[key];
    if (typeof value !== "string") continue;
    const toolId = value.trim();
    if (toolId !== "") return { key, toolId };
  }
  return null;
}

/** Calibrations in this project and window that carry comparison records. */
export async function listQualityCalibrations(
  projectId: string,
  window: ExperimentWindow,
  db: QualityQueriesDb = getDb(),
): Promise<Array<{ experimentName: string; comparisonCount: number }>> {
  const rows = await db
    .select({
      experimentName: otelLogs.experimentName,
      comparisonCount: sql<number>`count(*)::int`,
    })
    .from(otelLogs)
    .where(
      and(
        eq(otelLogs.projectId, projectId),
        eq(otelLogs.eventName, COMPARISON_EVENT),
        isNotNull(otelLogs.experimentName),
        gte(otelLogs.occurredAt, window.since),
        lt(otelLogs.occurredAt, window.until),
      ),
    )
    .groupBy(otelLogs.experimentName)
    .orderBy(desc(sql`count(*)`), asc(otelLogs.experimentName));

  return rows.flatMap((row) =>
    row.experimentName === null
      ? []
      : [
          {
            experimentName: row.experimentName,
            comparisonCount: row.comparisonCount,
          },
        ],
  );
}

/**
 * How many comparisons each offered window would hold, plus the oldest one.
 *
 * The window picker showed four options whose figures barely moved, which reads
 * as a broken control. They barely move because the metric is genuinely stable;
 * what changes is the SAMPLE, from 101 searches to 465. Putting the count on
 * each option makes the control visibly do something, and the earliest
 * timestamp is what lets the page say when a longer window is buying nothing
 * because telemetry is pruned before it.
 *
 * One scan with conditional aggregates rather than a query per option.
 */
export async function countComparisonsPerWindow(
  projectId: string,
  experimentName: string,
  windows: readonly number[],
  db: Pick<ReturnType<typeof getDb>, "select"> = getDb(),
): Promise<{ counts: Map<number, number>; earliest: Date | null }> {
  const counts = new Map<number, number>();
  if (windows.length === 0) return { counts, earliest: null };

  const longest = Math.max(...windows);
  const rows = await db
    .select({
      occurredAt: otelLogs.occurredAt,
    })
    .from(otelLogs)
    .where(
      and(
        eq(otelLogs.projectId, projectId),
        eq(otelLogs.experimentName, experimentName),
        eq(otelLogs.eventName, COMPARISON_EVENT),
        gte(otelLogs.occurredAt, new Date(Date.now() - longest * 24 * 60 * 60 * 1000)),
      ),
    );

  let earliest: Date | null = null;
  const times = rows.map((row) => {
    const at = row.occurredAt instanceof Date ? row.occurredAt : new Date(row.occurredAt);
    if (earliest === null || at < earliest) earliest = at;
    return at.getTime();
  });
  const now = Date.now();
  for (const days of windows) {
    const since = now - days * 24 * 60 * 60 * 1000;
    counts.set(days, times.filter((time) => time >= since).length);
  }
  return { counts, earliest };
}

/** Every project with shadow comparisons in the window: the admin index. */
export async function listQualityProjects(
  window: ExperimentWindow,
  db: QualityQueriesDb = getDb(),
): Promise<
  Array<{
    projectId: string;
    calibrationCount: number;
    comparisonCount: number;
    lastSeenAt: Date;
  }>
> {
  const rows = await db
    .select({
      projectId: otelLogs.projectId,
      calibrationCount: sql<number>`count(distinct ${otelLogs.experimentName})::int`,
      comparisonCount: sql<number>`count(*)::int`,
      lastSeenAt: sql<Date | string>`max(${otelLogs.occurredAt})`,
    })
    .from(otelLogs)
    .where(
      and(
        eq(otelLogs.eventName, COMPARISON_EVENT),
        gte(otelLogs.occurredAt, window.since),
        lt(otelLogs.occurredAt, window.until),
      ),
    )
    .groupBy(otelLogs.projectId)
    .orderBy(desc(sql`count(*)`));

  return rows.map((row) => ({
    projectId: row.projectId,
    calibrationCount: row.calibrationCount,
    comparisonCount: row.comparisonCount,
    lastSeenAt: toDate(row.lastSeenAt),
  }));
}

function stringAttr(key: string) {
  return sql<string | null>`case
    when jsonb_typeof(${otelLogs.experimentAttrs} -> ${key}) = 'string'
    then nullif(btrim(${otelLogs.experimentAttrs} ->> ${key}), '')
    else null
  end`;
}

function numberAttr(key: string) {
  return sql<number | null>`case
    when jsonb_typeof(${otelLogs.experimentAttrs} -> ${key}) = 'number'
    then (${otelLogs.experimentAttrs} ->> ${key})::float8
    else null
  end`;
}

function servedArmColumn() {
  return sql<string | null>`nullif(btrim(${otelLogs.experimentAttrs} ->> ${SERVED_ARM_KEY}), '')`;
}

/** Comparison records are attributed to the shadow arm, hence the fallback. */
function shadowArmColumn() {
  return sql<string | null>`coalesce(
    nullif(btrim(${otelLogs.experimentAttrs} ->> ${SHADOW_ARM_KEY}), ''),
    nullif(btrim(${otelLogs.experimentArm}), '')
  )`;
}

function stringArrayFrom(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((element): element is string => typeof element === "string");
}

function numberArrayFrom(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const numbers = value.filter(
    (element): element is number => typeof element === "number" && Number.isFinite(element),
  );
  return numbers.length === 0 ? null : numbers;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Searches the experiment served without a shadow: a `selection` record with
 * no `comparison` for the same selection id. One arm, the serving one, with
 * its ranked list and the invoked tool. This is what an offline phase leaves
 * behind, when only the reference arm ran; the Boost panel scores these on
 * the reference alone and starts the adaptive curve where comparisons begin.
 * Same window and cap semantics as {@link loadEvaluableSelections}.
 */
export async function loadServedOnlySelections(
  projectId: string,
  experimentName: string,
  window: ExperimentWindow,
  db: QualityQueriesDb = getDb(),
  limit: number = MAX_SELECTIONS,
): Promise<EvaluableSelection[]> {
  const rows = await db
    .select({
      selectionId: otelLogs.experimentSelectionId,
      occurredAt: otelLogs.occurredAt,
      query: stringAttr(QUERY_KEY),
      servedArm: sql<string | null>`coalesce(
        nullif(btrim(${otelLogs.experimentAttrs} ->> ${EFFECTIVE_ARM_KEY}), ''),
        nullif(btrim(${otelLogs.experimentArm}), '')
      )`,
    })
    .from(otelLogs)
    .where(
      and(
        eq(otelLogs.projectId, projectId),
        eq(otelLogs.experimentName, experimentName),
        eq(otelLogs.eventName, SELECTION_EVENT),
        isNotNull(otelLogs.experimentSelectionId),
        gte(otelLogs.occurredAt, window.since),
        lt(otelLogs.occurredAt, window.until),
        sql`not exists (
          select 1 from ${otelLogs} c
          where c.project_id = ${otelLogs.projectId}
            and c.experiment_selection_id = ${otelLogs.experimentSelectionId}
            and c.event_name = ${COMPARISON_EVENT}
        )`,
      ),
    )
    .orderBy(desc(otelLogs.occurredAt), desc(otelLogs.id))
    .limit(limit);

  const seen = new Set<string>();
  const kept = rows.filter((row) => {
    if (row.selectionId === null || row.servedArm === null || seen.has(row.selectionId))
      return false;
    seen.add(row.selectionId);
    return true;
  });
  const selectionIds = kept.map((row) => row.selectionId as string);
  const [results, invocations] = await Promise.all([
    selectionResults(projectId, selectionIds, db),
    selectionInvocations(projectId, selectionIds, db),
  ]);

  const selections: EvaluableSelection[] = [];
  for (const row of kept) {
    const selectionId = row.selectionId as string;
    const arm = row.servedArm as string;
    const recorded = results.get(selectionId)?.get(arm);
    selections.push({
      selectionId,
      occurredAt: toDate(row.occurredAt),
      query: row.query,
      arms: [
        {
          arm,
          role: "serving",
          resultIds: recorded?.ids ?? [],
          resultScores: recorded?.scores ?? null,
          requestedK: null,
          durationMs: null,
          outcome: null,
        },
      ],
      invokedToolId: invocations.tools.get(selectionId) ?? null,
      invokedRank: invocations.ranks.get(selectionId) ?? null,
    });
  }
  selections.reverse();
  return selections;
}
