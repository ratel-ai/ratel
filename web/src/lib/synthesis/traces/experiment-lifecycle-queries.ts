import { and, asc, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { alias as aliasTable } from "drizzle-orm/pg-core";
import { otelLogs } from "@/lib/ingest/otlp/schema";
import { getDb } from "@/lib/platform/db/client";
import type { ExperimentWindow } from "@/lib/synthesis/experiments/service";
import type {
  ExperimentArmConversionMetrics,
  ExperimentConversionMetrics,
  ExperimentLifecycleArmMetrics,
  ExperimentLifecycleDiagnostics,
} from "@/lib/synthesis/experiments/types";

export type ExperimentLifecycleQueriesDb = Pick<ReturnType<typeof getDb>, "select">;

const ARM_EVENT_NAMES = [
  "ratel.experiment.results",
  "ratel.experiment.comparison",
  "ratel.experiment.skip",
  "ratel.experiment.fallback",
  "ratel.experiment.drop",
] as const;
const COMPARISON_EVENT = "ratel.experiment.comparison";
const SKIP_EVENT = "ratel.experiment.skip";
const FALLBACK_EVENT = "ratel.experiment.fallback";
const DROP_EVENT = "ratel.experiment.drop";
const RESULTS_EVENT = "ratel.experiment.results";
const INVOCATION_EVENT = "ratel.experiment.invocation";
const OUTCOME_EVENT = "ratel.experiment.outcome";
const TOP1_KEY = "ratel.experiment.agreement.top1";
const EXACT_ORDER_KEY = "ratel.experiment.agreement.exact_order";
const JACCARD_KEY = "ratel.experiment.agreement.jaccard_at_k";
const AGREEMENT_K_KEY = "ratel.experiment.agreement.k";
const DROP_REASON_KEY = "ratel.experiment.drop.reason";
const FALLBACK_EFFECTIVE_ARM_KEY = "ratel.experiment.fallback.effective_arm";
const INVOCATION_ATTRIBUTED_KEY = "ratel.experiment.invocation.attributed";
const EFFECTIVE_ARM_KEY = "ratel.experiment.effective_arm";
const INVOCATION_RANK_KEY = "ratel.experiment.invocation.rank";
const INVOCATION_AGE_MS_KEY = "ratel.experiment.invocation.age_ms";
const OUTCOME_LABEL_KEY = "ratel.experiment.outcome.label";
const OUTCOME_SCORE_KEY = "ratel.experiment.outcome.score";

/** Aggregate rank agreement and reliability funnel metrics per shadow arm. */
export async function listExperimentLifecycleArmMetrics(
  projectId: string,
  experimentName: string,
  window: ExperimentWindow,
  db: ExperimentLifecycleQueriesDb = getDb(),
): Promise<ExperimentLifecycleArmMetrics[]> {
  const comparisonCount = sql<number>`count(*) filter (where ${otelLogs.eventName} = ${COMPARISON_EVENT})::int`;
  const skipCount = sql<number>`count(*) filter (where ${otelLogs.eventName} = ${SKIP_EVENT})::int`;
  const fallbackCount = sql<number>`count(*) filter (where ${otelLogs.eventName} = ${FALLBACK_EVENT})::int`;
  const dropCount = sql<number>`count(*) filter (where ${otelLogs.eventName} = ${DROP_EVENT})::int`;
  const agreementK = sql<number | null>`case
    when count(distinct case
      when ${otelLogs.eventName} = ${COMPARISON_EVENT}
        and jsonb_typeof(${otelLogs.experimentAttrs} -> ${AGREEMENT_K_KEY}) = 'number'
      then (${otelLogs.experimentAttrs} ->> ${AGREEMENT_K_KEY})::int
    end) = 1
    then max(case
      when ${otelLogs.eventName} = ${COMPARISON_EVENT}
        and jsonb_typeof(${otelLogs.experimentAttrs} -> ${AGREEMENT_K_KEY}) = 'number'
      then (${otelLogs.experimentAttrs} ->> ${AGREEMENT_K_KEY})::int
    end)
    else null
  end`;
  const rows = await db
    .select({
      arm: otelLogs.experimentArm,
      role: otelLogs.experimentRole,
      comparisonCount,
      top1Rate: booleanAgreementRate(TOP1_KEY),
      exactOrderRate: booleanAgreementRate(EXACT_ORDER_KEY),
      averageJaccardAtK: numericAgreementAverage(JACCARD_KEY),
      agreementK,
      skipCount,
      fallbackCount,
      dropCount,
    })
    .from(otelLogs)
    .where(
      and(
        eq(otelLogs.projectId, projectId),
        eq(otelLogs.experimentName, experimentName),
        eq(otelLogs.experimentRole, "shadow"),
        isNotNull(otelLogs.experimentArm),
        sql`btrim(${otelLogs.experimentArm}) <> ''`,
        inArray(otelLogs.eventName, ARM_EVENT_NAMES),
        gte(otelLogs.occurredAt, window.since),
        lt(otelLogs.occurredAt, window.until),
      ),
    )
    .groupBy(otelLogs.experimentArm, otelLogs.experimentRole)
    .orderBy(asc(otelLogs.experimentArm));
  const dropReasons = await listDropReasons(projectId, experimentName, window, db);
  const reasonsByArm = new Map<string, Record<string, number>>();
  for (const row of dropReasons) {
    const reasons = reasonsByArm.get(row.arm) ?? {};
    reasons[row.reason] = row.count;
    reasonsByArm.set(row.arm, reasons);
  }

  return rows.map((row) => {
    const denominator = row.comparisonCount + row.dropCount + row.skipCount;
    return {
      arm: row.arm!,
      role: "shadow",
      comparisonCount: row.comparisonCount,
      top1Rate: row.top1Rate,
      exactOrderRate: row.exactOrderRate,
      averageJaccardAtK: row.averageJaccardAtK,
      agreementK: row.agreementK,
      skipCount: row.skipCount,
      fallbackCount: row.fallbackCount,
      dropCount: row.dropCount,
      dropsByReason: reasonsByArm.get(row.arm!) ?? {},
      shadowCoverage: denominator === 0 ? null : row.comparisonCount / denominator,
    };
  });
}

/** Aggregate delayed outcomes and later invocations by the arm that served. */
export async function getExperimentConversionMetrics(
  projectId: string,
  experimentName: string,
  window: ExperimentWindow,
  db: ExperimentLifecycleQueriesDb = getDb(),
): Promise<ExperimentConversionMetrics> {
  const outcomeRows = experimentOutcomes(projectId, experimentName, window, db);
  const invocationRows = experimentInvocations(projectId, experimentName, window, db);
  const [outcomes, labels, invocations, ranks, [invocationTotals]] = await Promise.all([
    db
      .select({
        arm: outcomeRows.effectiveArm,
        outcomeCount: sql<number>`count(*)::int`,
        unlabeledOutcomeCount: sql<number>`count(*) filter (where ${outcomeRows.label} is null)::int`,
        averageOutcomeScore: sql<number | null>`avg(${outcomeRows.score})::float8`,
      })
      .from(outcomeRows)
      .groupBy(outcomeRows.effectiveArm),
    db
      .select({
        arm: outcomeRows.effectiveArm,
        label: outcomeRows.label,
        count: sql<number>`count(*)::int`,
      })
      .from(outcomeRows)
      .where(isNotNull(outcomeRows.label))
      .groupBy(outcomeRows.effectiveArm, outcomeRows.label),
    db
      .select({
        arm: invocationRows.effectiveArm,
        invocationCount: sql<number>`count(*)::int`,
        servedInvocationCount: sql<number>`count(*) filter (where ${invocationRows.rank} >= 0)::int`,
        notServedInvocationCount: sql<number>`count(*) filter (where ${invocationRows.rank} = -1)::int`,
        averageInvocationAgeMs: sql<number | null>`avg(${invocationRows.ageMs})::float8`,
      })
      .from(invocationRows)
      .where(isNotNull(invocationRows.effectiveArm))
      .groupBy(invocationRows.effectiveArm),
    db
      .select({
        arm: invocationRows.effectiveArm,
        rank: invocationRows.rank,
        count: sql<number>`count(*)::int`,
      })
      .from(invocationRows)
      .where(and(isNotNull(invocationRows.effectiveArm), isNotNull(invocationRows.rank)))
      .groupBy(invocationRows.effectiveArm, invocationRows.rank),
    db
      .select({
        invocationCount: sql<number>`count(*)::int`,
        attributedInvocationCount: sql<number>`count(*) filter (where ${invocationRows.effectiveArm} is not null)::int`,
      })
      .from(invocationRows),
  ]);

  const outcomesByArm = new Map<string, ExperimentArmConversionMetrics>();
  for (const row of outcomes) {
    if (row.arm === null) continue;
    outcomesByArm.set(
      row.arm,
      emptyConversionArm(row.arm, {
        outcomeCount: row.outcomeCount,
        unlabeledOutcomeCount: row.unlabeledOutcomeCount,
        averageOutcomeScore: row.averageOutcomeScore,
      }),
    );
  }
  for (const row of labels) {
    if (row.arm === null || row.label === null) continue;
    const arm = outcomesByArm.get(row.arm) ?? emptyConversionArm(row.arm);
    arm.outcomesByLabel[row.label] = row.count;
    outcomesByArm.set(row.arm, arm);
  }
  for (const row of invocations) {
    if (row.arm === null) continue;
    const arm = outcomesByArm.get(row.arm) ?? emptyConversionArm(row.arm);
    arm.invocationCount = row.invocationCount;
    arm.servedInvocationCount = row.servedInvocationCount;
    arm.notServedInvocationCount = row.notServedInvocationCount;
    arm.averageInvocationAgeMs = row.averageInvocationAgeMs;
    outcomesByArm.set(row.arm, arm);
  }
  for (const row of ranks) {
    if (row.arm === null || row.rank === null) continue;
    const arm = outcomesByArm.get(row.arm) ?? emptyConversionArm(row.arm);
    arm.invocationRankHistogram[String(row.rank)] = row.count;
    outcomesByArm.set(row.arm, arm);
  }

  const invocationCount = invocationTotals?.invocationCount ?? 0;
  const attributedInvocationCount = invocationTotals?.attributedInvocationCount ?? 0;
  return {
    arms: [...outcomesByArm.values()].sort((left, right) => compareStrings(left.arm, right.arm)),
    invocationCount,
    attributedInvocationCount,
    unattributedInvocationCount: invocationCount - attributedInvocationCount,
    invocationAttributionRate:
      invocationCount === 0 ? null : attributedInvocationCount / invocationCount,
    unresolvedOutcomeCount: outcomes.find((row) => row.arm === null)?.outcomeCount ?? 0,
  };
}

/** Probe whether arm-anchored lifecycle events reached this project and window. */
export async function getExperimentLifecycleDiagnostics(
  projectId: string,
  window: ExperimentWindow,
  db: ExperimentLifecycleQueriesDb = getDb(),
): Promise<ExperimentLifecycleDiagnostics> {
  const [row] = await db
    .select({
      hasLifecycleEvents: sql<boolean>`coalesce(bool_or(
        ${otelLogs.occurredAt} >= ${window.since}
        and ${otelLogs.occurredAt} < ${window.until}
      ), false)`,
      latestLogAt: sql<Date | string | null>`max(${otelLogs.occurredAt})`,
    })
    .from(otelLogs)
    .where(and(eq(otelLogs.projectId, projectId), inArray(otelLogs.eventName, ARM_EVENT_NAMES)));

  return {
    hasLifecycleEvents: row?.hasLifecycleEvents ?? false,
    latestLogAt:
      row?.latestLogAt == null
        ? null
        : row.latestLogAt instanceof Date
          ? row.latestLogAt
          : new Date(row.latestLogAt),
  };
}

async function listDropReasons(
  projectId: string,
  experimentName: string,
  window: ExperimentWindow,
  db: ExperimentLifecycleQueriesDb,
): Promise<Array<{ arm: string; reason: string; count: number }>> {
  const reason = sql<string>`case
    when jsonb_typeof(${otelLogs.experimentAttrs} -> ${DROP_REASON_KEY}) = 'string'
    then ${otelLogs.experimentAttrs} ->> ${DROP_REASON_KEY}
    else 'unknown'
  end`.as("drop_reason");
  const drops = db
    .select({ arm: otelLogs.experimentArm, reason })
    .from(otelLogs)
    .where(
      and(
        eq(otelLogs.projectId, projectId),
        eq(otelLogs.experimentName, experimentName),
        eq(otelLogs.experimentRole, "shadow"),
        isNotNull(otelLogs.experimentArm),
        sql`btrim(${otelLogs.experimentArm}) <> ''`,
        eq(otelLogs.eventName, DROP_EVENT),
        gte(otelLogs.occurredAt, window.since),
        lt(otelLogs.occurredAt, window.until),
      ),
    )
    .as("experiment_drop_reasons");
  const rows = await db
    .select({
      arm: drops.arm,
      reason: drops.reason,
      count: sql<number>`count(*)::int`,
    })
    .from(drops)
    .groupBy(drops.arm, drops.reason)
    .orderBy(asc(drops.arm), asc(drops.reason));

  return rows.map((row) => ({
    arm: row.arm!,
    reason: row.reason,
    count: row.count,
  }));
}

function experimentOutcomes(
  projectId: string,
  experimentName: string,
  window: ExperimentWindow,
  db: ExperimentLifecycleQueriesDb,
) {
  const resultsLog = aliasTable(otelLogs, "conversion_serving_results_log");
  const fallbackLog = aliasTable(otelLogs, "conversion_fallback_log");
  const outcomeLog = aliasTable(otelLogs, "conversion_outcome_log");
  const servingResults = db
    .select({
      selectionId: resultsLog.experimentSelectionId,
      arm: sql<string>`max(${resultsLog.experimentArm})`.as("serving_arm"),
    })
    .from(resultsLog)
    .where(
      and(
        eq(resultsLog.projectId, projectId),
        eq(resultsLog.experimentName, experimentName),
        eq(resultsLog.eventName, RESULTS_EVENT),
        eq(resultsLog.experimentRole, "serving"),
        isNotNull(resultsLog.experimentSelectionId),
        isNotNull(resultsLog.experimentArm),
        sql`btrim(${resultsLog.experimentArm}) <> ''`,
      ),
    )
    .groupBy(resultsLog.experimentSelectionId)
    .as("conversion_serving_results");
  const fallbacks = db
    .select({
      selectionId: fallbackLog.experimentSelectionId,
      arm: sql<string | null>`max(case
        when jsonb_typeof(${fallbackLog.experimentAttrs} -> ${FALLBACK_EFFECTIVE_ARM_KEY}) = 'string'
        then nullif(btrim(${fallbackLog.experimentAttrs} ->> ${FALLBACK_EFFECTIVE_ARM_KEY}), '')
      end)`.as("fallback_arm"),
    })
    .from(fallbackLog)
    .where(
      and(
        eq(fallbackLog.projectId, projectId),
        eq(fallbackLog.experimentName, experimentName),
        eq(fallbackLog.eventName, FALLBACK_EVENT),
        isNotNull(fallbackLog.experimentSelectionId),
      ),
    )
    .groupBy(fallbackLog.experimentSelectionId)
    .as("conversion_fallbacks");

  return db
    .select({
      effectiveArm: sql<string | null>`coalesce(${fallbacks.arm}, ${servingResults.arm})`.as(
        "effective_arm",
      ),
      label: sql<string | null>`case
        when jsonb_typeof(${outcomeLog.experimentAttrs} -> ${OUTCOME_LABEL_KEY}) = 'string'
        then nullif(btrim(${outcomeLog.experimentAttrs} ->> ${OUTCOME_LABEL_KEY}), '')
        else null
      end`.as("outcome_label"),
      score: sql<number | null>`case
        when jsonb_typeof(${outcomeLog.experimentAttrs} -> ${OUTCOME_SCORE_KEY}) = 'number'
        then (${outcomeLog.experimentAttrs} ->> ${OUTCOME_SCORE_KEY})::float8
        else null
      end`.as("outcome_score"),
    })
    .from(outcomeLog)
    .leftJoin(servingResults, eq(outcomeLog.experimentSelectionId, servingResults.selectionId))
    .leftJoin(fallbacks, eq(outcomeLog.experimentSelectionId, fallbacks.selectionId))
    .where(
      and(
        eq(outcomeLog.projectId, projectId),
        eq(outcomeLog.experimentName, experimentName),
        eq(outcomeLog.eventName, OUTCOME_EVENT),
        gte(outcomeLog.occurredAt, window.since),
        lt(outcomeLog.occurredAt, window.until),
      ),
    )
    .as("experiment_conversion_outcomes");
}

function experimentInvocations(
  projectId: string,
  experimentName: string,
  window: ExperimentWindow,
  db: ExperimentLifecycleQueriesDb,
) {
  const invocationLog = aliasTable(otelLogs, "conversion_invocation_log");
  const isAttributed = sql`jsonb_typeof(${invocationLog.experimentAttrs} -> ${INVOCATION_ATTRIBUTED_KEY}) = 'boolean'
    and (${invocationLog.experimentAttrs} ->> ${INVOCATION_ATTRIBUTED_KEY})::boolean`;

  return db
    .select({
      effectiveArm: sql<string | null>`case
        when ${isAttributed}
          and jsonb_typeof(${invocationLog.experimentAttrs} -> ${EFFECTIVE_ARM_KEY}) = 'string'
        then nullif(btrim(${invocationLog.experimentAttrs} ->> ${EFFECTIVE_ARM_KEY}), '')
        else null
      end`.as("effective_arm"),
      rank: sql<number | null>`case
        when ${isAttributed}
          and jsonb_typeof(${invocationLog.experimentAttrs} -> ${INVOCATION_RANK_KEY}) = 'number'
        then (${invocationLog.experimentAttrs} ->> ${INVOCATION_RANK_KEY})::int
        else null
      end`.as("invocation_rank"),
      ageMs: sql<number | null>`case
        when ${isAttributed}
          and jsonb_typeof(${invocationLog.experimentAttrs} -> ${INVOCATION_AGE_MS_KEY}) = 'number'
        then (${invocationLog.experimentAttrs} ->> ${INVOCATION_AGE_MS_KEY})::float8
        else null
      end`.as("invocation_age_ms"),
    })
    .from(invocationLog)
    .where(
      and(
        eq(invocationLog.projectId, projectId),
        eq(invocationLog.experimentName, experimentName),
        eq(invocationLog.eventName, INVOCATION_EVENT),
        gte(invocationLog.occurredAt, window.since),
        lt(invocationLog.occurredAt, window.until),
      ),
    )
    .as("experiment_conversion_invocations");
}

function emptyConversionArm(
  arm: string,
  overrides: Partial<ExperimentArmConversionMetrics> = {},
): ExperimentArmConversionMetrics {
  return {
    arm,
    outcomeCount: 0,
    outcomesByLabel: {},
    unlabeledOutcomeCount: 0,
    averageOutcomeScore: null,
    invocationCount: 0,
    servedInvocationCount: 0,
    notServedInvocationCount: 0,
    invocationRankHistogram: {},
    averageInvocationAgeMs: null,
    ...overrides,
  };
}

function booleanAgreementRate(key: string) {
  return sql<number | null>`avg(case
    when ${otelLogs.eventName} = ${COMPARISON_EVENT}
      and jsonb_typeof(${otelLogs.experimentAttrs} -> ${key}) = 'boolean'
    then case when (${otelLogs.experimentAttrs} ->> ${key})::boolean then 1 else 0 end
  end)::float8`;
}

function numericAgreementAverage(key: string) {
  return sql<number | null>`avg(case
    when ${otelLogs.eventName} = ${COMPARISON_EVENT}
      and jsonb_typeof(${otelLogs.experimentAttrs} -> ${key}) = 'number'
    then (${otelLogs.experimentAttrs} ->> ${key})::float8
  end)::float8`;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
