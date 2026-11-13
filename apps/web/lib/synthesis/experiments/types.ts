export type ExperimentMode = "split" | "shadow" | "mixed";

export type ExperimentIssueKind =
  | "capability_absent"
  | "ranking_divergence"
  | "arm_imbalance"
  | "error_rate_delta"
  | "latency_delta"
  | "missing_arm"
  | "low_sample";

export type ExperimentIssueSeverity = "error" | "warning" | "info";

export type CapabilityType = "tool" | "skill";

export interface ExperimentArmAggregate {
  experimentName: string;
  arm: string;
  traceCount: number;
  experimentTraceCount: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export interface MultiArmTraceCount {
  experimentName: string;
  traceCount: number;
}

export interface ExperimentArmSummary {
  arm: string;
  traceCount: number;
  traceShare: number;
}

export interface ExperimentSummary {
  name: string;
  mode: ExperimentMode;
  baselineArm: string;
  traceCount: number;
  multiArmTraceCount: number;
  arms: ExperimentArmSummary[];
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export interface ArmMetricAggregate {
  arm: string;
  traceCount: number;
  errorTraceCount: number;
  averageLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  averageInputTokens: number;
  averageOutputTokens: number;
  averageCostUsd: number;
  averageSearchCount: number;
  averageSearchHitCount: number | null;
}

export interface ExperimentLifecycleArmMetrics {
  arm: string;
  role: "shadow";
  comparisonCount: number;
  top1Rate: number | null;
  exactOrderRate: number | null;
  averageJaccardAtK: number | null;
  agreementK: number | null;
  skipCount: number;
  fallbackCount: number;
  dropCount: number;
  dropsByReason: Record<string, number>;
  shadowCoverage: number | null;
}

export interface ExperimentLifecycleDiagnostics {
  hasLifecycleEvents: boolean;
  latestLogAt: Date | null;
}

export interface ExperimentArmConversionMetrics {
  arm: string;
  outcomeCount: number;
  outcomesByLabel: Record<string, number>;
  unlabeledOutcomeCount: number;
  averageOutcomeScore: number | null;
  invocationCount: number;
  servedInvocationCount: number;
  notServedInvocationCount: number;
  invocationRankHistogram: Record<string, number>;
  averageInvocationAgeMs: number | null;
}

export interface ExperimentConversionSummary {
  invocationCount: number;
  attributedInvocationCount: number;
  unattributedInvocationCount: number;
  invocationAttributionRate: number | null;
  unresolvedOutcomeCount: number;
}

export interface ExperimentConversionMetrics extends ExperimentConversionSummary {
  arms: ExperimentArmConversionMetrics[];
}

export interface ArmMetrics extends ArmMetricAggregate {
  errorRate: number;
}

export interface MetricDelta {
  absolute: number;
  relative: number | null;
}

export interface ArmMetricDeltas {
  errorRate: MetricDelta;
  averageLatencyMs: MetricDelta;
  p95LatencyMs: MetricDelta;
  averageInputTokens: MetricDelta;
  averageOutputTokens: MetricDelta;
  averageCostUsd: MetricDelta;
  averageSearchHitCount: MetricDelta | null;
}

export interface ComparedArm {
  arm: string;
  metrics: ArmMetrics;
  deltas: ArmMetricDeltas | null;
  lifecycle?: ExperimentLifecycleArmMetrics | null;
  conversion?: ExperimentArmConversionMetrics | null;
}

export interface CapabilityHit {
  type: CapabilityType;
  id: string;
  rank: number;
  score: number | null;
}

export interface ArmSearchSpan {
  arm: string;
  traceId: string;
  spanId: string;
  reportedHitCount: number | null;
  hits: CapabilityHit[];
}

export interface CapabilityArmComparison {
  arm: string;
  appearances: number;
  averageRank: number | null;
  rankDelta: number | null;
  absent: boolean;
}

export interface CapabilityComparison {
  type: CapabilityType;
  id: string;
  baselineAppearances: number;
  baselineAverageRank: number | null;
  arms: CapabilityArmComparison[];
  maxAbsoluteRankDelta: number | null;
}

export interface CapabilityComparisonSet {
  hasRankings: boolean;
  rows: CapabilityComparison[];
  reportedHitMetrics: Array<{
    arm: string;
    total: number | null;
    searchSpanCount: number;
    averagePerSearch: number | null;
  }>;
}

interface BaseExperimentIssue {
  kind: ExperimentIssueKind;
  severity: ExperimentIssueSeverity;
  arm: string | null;
  message: string;
}

export interface CapabilityAbsentIssue extends BaseExperimentIssue {
  kind: "capability_absent";
  capabilityType: CapabilityType;
  capabilityId: string;
  baselineAppearances: number;
}

export interface RankingDivergenceIssue extends BaseExperimentIssue {
  kind: "ranking_divergence";
  capabilityType: CapabilityType;
  capabilityId: string;
  rankDelta: number;
}

export interface ArmImbalanceIssue extends BaseExperimentIssue {
  kind: "arm_imbalance";
  smallestArm: string;
  largestArm: string;
  sampleRatio: number;
}

export interface ErrorRateDeltaIssue extends BaseExperimentIssue {
  kind: "error_rate_delta";
  delta: number;
}

export interface LatencyDeltaIssue extends BaseExperimentIssue {
  kind: "latency_delta";
  relativeDelta: number;
}

export interface MissingArmIssue extends BaseExperimentIssue {
  kind: "missing_arm";
  observedArms: string[];
}

export interface LowSampleIssue extends BaseExperimentIssue {
  kind: "low_sample";
  traceCount: number;
}

export type ExperimentIssue =
  | CapabilityAbsentIssue
  | RankingDivergenceIssue
  | ArmImbalanceIssue
  | ErrorRateDeltaIssue
  | LatencyDeltaIssue
  | MissingArmIssue
  | LowSampleIssue;

export interface ExperimentComparison {
  name: string;
  mode: ExperimentMode;
  baselineArm: string;
  arms: ComparedArm[];
  capabilities: CapabilityComparisonSet;
  lifecycleDiagnostics?: ExperimentLifecycleDiagnostics;
  conversionSummary?: ExperimentConversionSummary;
  issues: ExperimentIssue[];
}
