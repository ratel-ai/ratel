import type {
  CapabilityComparisonSet,
  ComparedArm,
  ExperimentIssue,
  ExperimentIssueSeverity,
} from "./types";

export const ISSUE_THRESHOLDS = {
  minimumSampleSize: 20,
  capabilityAbsentMinAppearances: 3,
  rankingDivergence: 3,
  armImbalanceMinRatio: 0.5,
  errorRateDelta: 0.05,
  latencyRelativeDelta: 0.25,
} as const;

const SEVERITY_ORDER: Record<ExperimentIssueSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

export function detectExperimentIssues(
  baselineArm: ComparedArm,
  comparedArms: ComparedArm[],
  capabilitySet: CapabilityComparisonSet,
): ExperimentIssue[] {
  const issues: ExperimentIssue[] = [];
  const arms = [baselineArm, ...comparedArms];
  const observedArms = [baselineArm.arm, ...comparedArms.map((arm) => arm.arm)];
  if (observedArms.length < 2) {
    issues.push({
      kind: "missing_arm",
      severity: "error",
      arm: null,
      message: `Expected at least 2 experiment arms; observed ${observedArms.join(", ")}`,
      observedArms,
    });
  }

  for (const arm of arms) {
    if (arm.metrics.traceCount >= ISSUE_THRESHOLDS.minimumSampleSize) continue;
    issues.push({
      kind: "low_sample",
      severity: "info",
      arm: arm.arm,
      message: `${arm.arm} has ${arm.metrics.traceCount} traces; minimum sample is ${ISSUE_THRESHOLDS.minimumSampleSize}`,
      traceCount: arm.metrics.traceCount,
    });
  }

  if (arms.length >= 2) {
    const armsBySample = [...arms].sort(
      (left, right) =>
        left.metrics.traceCount - right.metrics.traceCount || left.arm.localeCompare(right.arm),
    );
    const smallest = armsBySample[0];
    const largest = armsBySample[armsBySample.length - 1];
    if (smallest && largest && largest.metrics.traceCount > 0) {
      const sampleRatio = smallest.metrics.traceCount / largest.metrics.traceCount;
      if (sampleRatio <= ISSUE_THRESHOLDS.armImbalanceMinRatio) {
        issues.push({
          kind: "arm_imbalance",
          severity: "info",
          arm: null,
          message: `${smallest.arm} has ${smallest.metrics.traceCount} traces versus ${largest.arm} with ${largest.metrics.traceCount}`,
          smallestArm: smallest.arm,
          largestArm: largest.arm,
          sampleRatio,
        });
      }
    }
  }

  for (const comparedArm of comparedArms) {
    const delta = comparedArm.deltas?.errorRate.absolute;
    if (delta === undefined || !meetsAbsoluteThreshold(delta, ISSUE_THRESHOLDS.errorRateDelta)) {
      continue;
    }
    issues.push({
      kind: "error_rate_delta",
      severity: "error",
      arm: comparedArm.arm,
      message: `${comparedArm.arm} error rate differs from ${baselineArm.arm} by ${delta}`,
      delta,
    });
  }

  for (const comparedArm of comparedArms) {
    const relativeDelta = comparedArm.deltas?.p95LatencyMs.relative;
    if (
      relativeDelta === null ||
      relativeDelta === undefined ||
      !meetsAbsoluteThreshold(relativeDelta, ISSUE_THRESHOLDS.latencyRelativeDelta)
    ) {
      continue;
    }
    issues.push({
      kind: "latency_delta",
      severity: "warning",
      arm: comparedArm.arm,
      message: `${comparedArm.arm} p95 latency differs from ${baselineArm.arm} by ${relativeDelta * 100}%`,
      relativeDelta,
    });
  }

  for (const capability of capabilitySet.rows) {
    if (capability.baselineAppearances < ISSUE_THRESHOLDS.capabilityAbsentMinAppearances) {
      continue;
    }
    for (const arm of capability.arms) {
      if (!arm.absent) continue;
      issues.push({
        kind: "capability_absent",
        severity: "warning",
        arm: arm.arm,
        message: `${capability.type} ${capability.id} appeared ${capability.baselineAppearances} times in ${baselineArm.arm} but is absent from ${arm.arm}`,
        capabilityType: capability.type,
        capabilityId: capability.id,
        baselineAppearances: capability.baselineAppearances,
      });
    }
  }

  for (const capability of capabilitySet.rows) {
    for (const arm of capability.arms) {
      if (
        arm.rankDelta === null ||
        !meetsAbsoluteThreshold(arm.rankDelta, ISSUE_THRESHOLDS.rankingDivergence)
      ) {
        continue;
      }
      issues.push({
        kind: "ranking_divergence",
        severity: "warning",
        arm: arm.arm,
        message: `${capability.type} ${capability.id} rank differs from ${baselineArm.arm} by ${arm.rankDelta} in ${arm.arm}`,
        capabilityType: capability.type,
        capabilityId: capability.id,
        rankDelta: arm.rankDelta,
      });
    }
  }

  return issues.sort((left, right) => {
    const severityOrder = SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity];
    if (severityOrder !== 0) return severityOrder;

    const kindOrder = left.kind.localeCompare(right.kind);
    if (kindOrder !== 0) return kindOrder;

    return (left.arm ?? "").localeCompare(right.arm ?? "");
  });
}

function meetsAbsoluteThreshold(value: number, threshold: number): boolean {
  const magnitude = Math.max(1, Math.abs(value), threshold);
  const tolerance = Number.EPSILON * magnitude * 8;
  return Math.abs(value) >= threshold - tolerance;
}
