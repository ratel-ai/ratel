import type { ExperimentKind, RankingDiffSummary } from "./ranking";
import type { ExperimentLifecycleArmMetrics } from "./types";

/**
 * One independent way a shadow ranking can disagree with the served one. Facets
 * overlap on purpose: a comparison that drops a tool *and* reorders the rest
 * matches both `missing` and `order`, so filtering by one never hides the other.
 */
export type ComparisonFacet = "top1" | "order" | "missing" | "added" | "outcome";

/** How selected facets combine: `any` is OR, `all` is AND. */
export type ComparisonMatchMode = "any" | "all";

/** The comparison browser's filter: a base scope plus combined facets. */
export interface ComparisonFilterSelection {
  /** `mismatch` keeps the flagged subset; `all` browses every comparison. */
  scope: "mismatch" | "all";
  facets: ComparisonFacet[];
  match: ComparisonMatchMode;
}

/**
 * Shared contract for the ranking-shadow calibration view (calibration v2).
 * Rows are read from `otel_logs`: one `ratel.experiment.comparison` record per
 * shadow-tested selection, joined with both arms' `ratel.experiment.results`
 * records on `experiment_selection_id`. Comparison records ride the OTel Logs
 * signal, so they are a census even when arm spans are trace-sampled.
 */

/** Arm outcome vocabulary emitted by the SDK (open for forward compat). */
export type ExperimentArmOutcome = "ok" | "empty" | "error" | "timeout";

/** One comparison record joined with the selection's per-arm ranked results. */
export interface RankingComparisonRow {
  selectionId: string | null;
  occurredAt: Date;
  traceId: string | null;
  query: string | null;
  servedArm: string | null;
  shadowArm: string | null;
  servedOutcome: string | null;
  shadowOutcome: string | null;
  servedDurationMs: number | null;
  shadowDurationMs: number | null;
  servedHitCount: number | null;
  shadowHitCount: number | null;
  top1: boolean | null;
  exactOrder: boolean | null;
  overlapCount: number | null;
  jaccardAtK: number | null;
  agreementK: number | null;
  servedResultIds: string[] | null;
  shadowResultIds: string[] | null;
  servedResultScores: number[] | null;
  shadowResultScores: number[] | null;
}

/** Latency/outcome stats for one side (served or shadow) of a comparison pair. */
export interface ArmSideStats {
  outcomes: Record<string, number>;
  errorRate: number | null;
  averageDurationMs: number | null;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
}

/** Jaccard@k must be grouped by k: k is the request's own limit, not a constant. */
export interface JaccardByK {
  k: number;
  count: number;
  mean: number;
}

/** Census aggregates for one (servedArm, shadowArm) direction. */
export interface ArmPairAgreementSummary {
  servedArm: string;
  shadowArm: string;
  comparisonCount: number;
  mismatchCount: number;
  top1Rate: number | null;
  exactOrderRate: number | null;
  averageJaccardAtK: number | null;
  jaccardByK: JaccardByK[];
  served: ArmSideStats;
  shadow: ArmSideStats;
}

/**
 * Per-experiment comparison-record counts (kind detection + header totals).
 * Arm-agnostic on purpose: pair summaries require both arm attrs, but header
 * totals must cover every comparison record the browser can list.
 */
export interface ExperimentComparisonCount {
  experimentName: string;
  comparisonCount: number;
  mismatchCount: number;
}

/**
 * What the calibration index needs per experiment: which detail view fits, plus
 * the comparison census behind that choice. The census travels with the kind
 * because both fold out of the same `countExperimentComparisons` rows — and
 * because the index must show census counts, not the sampled per-arm trace
 * counts, which mix in single-arm and non-production traffic.
 */
export interface ExperimentCalibrationSummary {
  kind: ExperimentKind;
  comparisonCount: number;
  mismatchCount: number;
}

/** How often one experiment arm occupied each dispatch role. */
export interface ArmRoleBreakdown {
  arm: string;
  servingCount: number;
  shadowingCount: number;
  servingRate: number;
  shadowingRate: number;
}

/** One lifecycle log record belonging to a selection (drill-down inspector). */
export interface SelectionLogRecord {
  id: string;
  eventName: string;
  occurredAt: Date;
  traceId: string | null;
  arm: string | null;
  role: string | null;
  experimentAttrs: Record<string, unknown>;
}

/** Everything the selection inspector needs for one selection id. */
export interface SelectionDetail {
  selectionId: string;
  experimentName: string | null;
  records: SelectionLogRecord[];
  traceId: string | null;
  traceHasSpans: boolean;
}

/** Compact comparison-browser row with only presentation fields. */
export interface RankingComparisonRowView {
  selectionId: string | null;
  occurredAt: Date;
  traceId: string | null;
  query: string | null;
  servedArm: string | null;
  shadowArm: string | null;
  servedOutcome: string | null;
  shadowOutcome: string | null;
  servedDurationMs: number | null;
  shadowDurationMs: number | null;
  top1: boolean | null;
  exactOrder: boolean | null;
  agreementK: number | null;
  matchScore: number | null;
  servedResultIds: string[] | null;
  shadowResultIds: string[] | null;
  servedResultScores: number[] | null;
  shadowResultScores: number[] | null;
  diffSummary: RankingDiffSummary | null;
}

/** One filtered, paginated slice of the comparison browser. */
export interface ComparisonPage {
  rows: RankingComparisonRowView[];
  /** Rows matching the filter across the whole window, not just this page. */
  total: number;
}

/** View model for the ranking-shadow calibration detail page. */
export interface RankingCalibrationView {
  name: string;
  kind: Extract<ExperimentKind, "ranking-shadow">;
  pairs: ArmPairAgreementSummary[];
  arms: ArmRoleBreakdown[];
  lifecycle: ExperimentLifecycleArmMetrics[];
  comparisons: RankingComparisonRowView[];
  totalComparisonCount: number;
  mismatchCount: number;
  filteredComparisonCount: number;
}
