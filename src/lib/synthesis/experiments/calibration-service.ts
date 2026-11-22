import type {
  ArmPairAgreementSummary,
  ComparisonFilterSelection,
  ComparisonPage,
  ExperimentCalibrationSummary,
  ExperimentComparisonCount,
  RankingCalibrationView,
  RankingComparisonRow,
  RankingComparisonRowView,
} from "./calibration-types";
import { diffRankings, resolveExperimentKind, summarizeRankingDiff } from "./ranking";
import type { ExperimentWindow } from "./service";
import type { ExperimentLifecycleArmMetrics } from "./types";

export interface RankingComparisonListOptions {
  selection?: ComparisonFilterSelection;
  limit?: number;
  offset?: number;
}

/**
 * Read seam for the ranking-shadow calibration view. Implemented over
 * `otel_logs` by `lib/traces/experiment-calibration-queries.ts`; injected here
 * (dependency inversion) so the service composes pure folds without touching
 * the database.
 */
export interface CalibrationQueries {
  countExperimentComparisons(
    projectId: string,
    experimentNames: string[],
    window: ExperimentWindow,
  ): Promise<ExperimentComparisonCount[]>;
  getRankingComparisonSummary(
    projectId: string,
    experimentName: string,
    window: ExperimentWindow,
  ): Promise<ArmPairAgreementSummary[]>;
  listRankingComparisons(
    projectId: string,
    experimentName: string,
    window: ExperimentWindow,
    options: RankingComparisonListOptions,
  ): Promise<RankingComparisonRow[]>;
  countRankingComparisons(
    projectId: string,
    experimentName: string,
    window: ExperimentWindow,
    options: RankingComparisonListOptions,
  ): Promise<number>;
  listExperimentLifecycleArmMetrics(
    projectId: string,
    experimentName: string,
    window: ExperimentWindow,
  ): Promise<ExperimentLifecycleArmMetrics[]>;
}

export function createCalibrationService(queries: CalibrationQueries) {
  /**
   * Per-experiment kind plus comparison census, keyed by every requested name.
   * Experiments with no comparison record in the window are absent from the
   * count rows, so they are folded in here with a zero census rather than
   * dropped — the index renders a row for each name it asked about.
   */
  async function resolveCalibrationSummaries(
    projectId: string,
    experimentNames: string[],
    window: ExperimentWindow,
  ): Promise<Map<string, ExperimentCalibrationSummary>> {
    const counts = await queries.countExperimentComparisons(projectId, experimentNames, window);
    const countByName = new Map(counts.map((count) => [count.experimentName, count]));
    return new Map(
      experimentNames.map((name) => {
        const comparisonCount = countByName.get(name)?.comparisonCount ?? 0;
        return [
          name,
          {
            kind: resolveExperimentKind({ comparisonCount }),
            comparisonCount,
            mismatchCount: countByName.get(name)?.mismatchCount ?? 0,
          },
        ];
      }),
    );
  }

  /**
   * One filtered page of the comparison browser. Split out of the full view so
   * the browser can page and re-filter on its own, without re-running the
   * window-wide aggregates that don't change with the filter.
   */
  async function listComparisonPage(
    projectId: string,
    experimentName: string,
    window: ExperimentWindow,
    options: RankingComparisonListOptions = {},
  ): Promise<ComparisonPage> {
    const count = () => queries.countRankingComparisons(projectId, experimentName, window, options);
    if ((options.offset ?? 0) <= 0) {
      const [rows, total] = await Promise.all([
        queries.listRankingComparisons(projectId, experimentName, window, options),
        count(),
      ]);
      return { rows: rows.map(toComparisonRowView), total };
    }

    const total = await count();
    const boundedOptions = clampComparisonListOffset(options, total);
    const rows = await queries.listRankingComparisons(
      projectId,
      experimentName,
      window,
      boundedOptions,
    );
    return { rows: rows.map(toComparisonRowView), total };
  }

  async function getRankingCalibration(
    projectId: string,
    experimentName: string,
    window: ExperimentWindow,
    options: RankingComparisonListOptions = {},
  ): Promise<RankingCalibrationView | null> {
    const [pairs, page, lifecycle, counts] = await Promise.all([
      queries.getRankingComparisonSummary(projectId, experimentName, window),
      listComparisonPage(projectId, experimentName, window, options),
      queries.listExperimentLifecycleArmMetrics(projectId, experimentName, window),
      queries.countExperimentComparisons(projectId, [experimentName], window),
    ]);

    // Header totals come from the arm-agnostic census count: pair summaries
    // require both arm attributes, but the browser lists every record.
    const census = counts.find((count) => count.experimentName === experimentName);
    if (pairs.length === 0 && page.rows.length === 0 && (census?.comparisonCount ?? 0) === 0) {
      return null;
    }
    return {
      name: experimentName,
      kind: "ranking-shadow",
      pairs,
      arms: buildArmRoleBreakdowns(pairs),
      lifecycle,
      comparisons: page.rows,
      totalComparisonCount:
        census?.comparisonCount ?? sumBy(pairs, ({ comparisonCount }) => comparisonCount),
      mismatchCount: census?.mismatchCount ?? sumBy(pairs, ({ mismatchCount }) => mismatchCount),
      filteredComparisonCount: page.total,
    };
  }

  return {
    resolveCalibrationSummaries,
    getRankingCalibration,
    listComparisonPage,
  };
}

function toComparisonRowView(row: RankingComparisonRow): RankingComparisonRowView {
  const diff =
    row.servedResultIds !== null && row.shadowResultIds !== null
      ? diffRankings(row.servedResultIds, row.shadowResultIds)
      : null;
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
    top1: row.top1,
    exactOrder: row.exactOrder,
    agreementK: row.agreementK,
    matchScore: row.jaccardAtK,
    servedResultIds: row.servedResultIds,
    shadowResultIds: row.shadowResultIds,
    servedResultScores: row.servedResultScores,
    shadowResultScores: row.shadowResultScores,
    diffSummary: diff === null ? null : summarizeRankingDiff(diff),
  };
}

function clampComparisonListOffset(
  options: RankingComparisonListOptions,
  total: number,
): RankingComparisonListOptions {
  const { limit, offset } = options;
  if (
    !Number.isSafeInteger(limit) ||
    limit === undefined ||
    limit <= 0 ||
    !Number.isSafeInteger(offset) ||
    offset === undefined ||
    offset <= 0
  ) {
    return options;
  }
  const pageCount = Math.max(1, Math.ceil(Math.max(0, total) / limit));
  const maxOffset = (pageCount - 1) * limit;
  return offset <= maxOffset ? options : { ...options, offset: maxOffset };
}

function buildArmRoleBreakdowns(pairs: ArmPairAgreementSummary[]): RankingCalibrationView["arms"] {
  const counts = new Map<string, { servingCount: number; shadowingCount: number }>();
  for (const pair of pairs) {
    const served = counts.get(pair.servedArm) ?? {
      servingCount: 0,
      shadowingCount: 0,
    };
    served.servingCount += pair.comparisonCount;
    counts.set(pair.servedArm, served);

    const shadow = counts.get(pair.shadowArm) ?? {
      servingCount: 0,
      shadowingCount: 0,
    };
    shadow.shadowingCount += pair.comparisonCount;
    counts.set(pair.shadowArm, shadow);
  }

  return [...counts].map(([arm, roleCounts]) => {
    const total = roleCounts.servingCount + roleCounts.shadowingCount;
    return {
      arm,
      ...roleCounts,
      servingRate: total === 0 ? 0 : roleCounts.servingCount / total,
      shadowingRate: total === 0 ? 0 : roleCounts.shadowingCount / total,
    };
  });
}

function sumBy<T>(items: T[], value: (item: T) => number): number {
  return items.reduce((total, item) => total + value(item), 0);
}
