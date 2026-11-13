import type {
  ArmMetricAggregate,
  ArmMetrics,
  ComparedArm,
  ExperimentArmConversionMetrics,
  ExperimentLifecycleArmMetrics,
  MetricDelta,
} from "./types";

export function compareArmMetrics(
  baselineArm: string,
  aggregates: ArmMetricAggregate[],
): ComparedArm[] {
  const metrics = aggregates.map(withErrorRate).sort((left, right) => {
    if (left.arm === baselineArm) return -1;
    if (right.arm === baselineArm) return 1;
    return compareStrings(left.arm, right.arm);
  });
  const baseline = metrics.find(({ arm }) => arm === baselineArm);
  if (!baseline) {
    throw new Error(`Baseline arm "${baselineArm}" is missing`);
  }

  return metrics.map((armMetrics) => ({
    arm: armMetrics.arm,
    metrics: armMetrics,
    deltas:
      armMetrics.arm === baselineArm
        ? null
        : {
            errorRate: metricDelta(armMetrics.errorRate, baseline.errorRate),
            averageLatencyMs: metricDelta(armMetrics.averageLatencyMs, baseline.averageLatencyMs),
            p95LatencyMs: metricDelta(armMetrics.p95LatencyMs, baseline.p95LatencyMs),
            averageInputTokens: metricDelta(
              armMetrics.averageInputTokens,
              baseline.averageInputTokens,
            ),
            averageOutputTokens: metricDelta(
              armMetrics.averageOutputTokens,
              baseline.averageOutputTokens,
            ),
            averageCostUsd: metricDelta(armMetrics.averageCostUsd, baseline.averageCostUsd),
            averageSearchHitCount: nullableMetricDelta(
              armMetrics.averageSearchHitCount,
              baseline.averageSearchHitCount,
            ),
          },
  }));
}

export function attachExperimentLifecycleMetrics(
  arms: ComparedArm[],
  lifecycleMetrics: ExperimentLifecycleArmMetrics[],
): ComparedArm[] {
  const metricsByArm = new Map(lifecycleMetrics.map((metrics) => [metrics.arm, metrics]));
  return arms.map((arm) => ({
    ...arm,
    lifecycle: metricsByArm.get(arm.arm) ?? null,
  }));
}

export function attachExperimentConversionMetrics(
  arms: ComparedArm[],
  conversionMetrics: ExperimentArmConversionMetrics[],
): ComparedArm[] {
  const metricsByArm = new Map(conversionMetrics.map((metrics) => [metrics.arm, metrics]));
  return arms.map((arm) => ({
    ...arm,
    conversion: metricsByArm.get(arm.arm) ?? null,
  }));
}

function withErrorRate(aggregate: ArmMetricAggregate): ArmMetrics {
  return {
    ...aggregate,
    errorRate: aggregate.traceCount === 0 ? 0 : aggregate.errorTraceCount / aggregate.traceCount,
  };
}

function nullableMetricDelta(value: number | null, baseline: number | null): MetricDelta | null {
  if (value === null || baseline === null) return null;
  return metricDelta(value, baseline);
}

function metricDelta(value: number, baseline: number): MetricDelta {
  const absolute = value - baseline;
  return {
    absolute,
    relative: baseline === 0 ? null : absolute / baseline,
  };
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
