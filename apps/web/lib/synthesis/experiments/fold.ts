import type { ExperimentArmAggregate, MultiArmTraceCount } from "./types";

/**
 * One deduped `(experimentName, arm, traceId)` row of experiment-tagged spans,
 * with the min/max span start already rolled up per group. This is the grain
 * experiment detection scans exactly once; both arm and multi-arm rollups fold
 * out of it in JS instead of costing extra passes over `otel_spans`.
 */
export interface ExperimentTraceArm {
  experimentName: string;
  arm: string;
  traceId: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export interface ExperimentDetectionAggregates {
  armAggregates: ExperimentArmAggregate[];
  multiArmCounts: MultiArmTraceCount[];
}

interface ArmRollup {
  traceIds: Set<string>;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

interface ExperimentRollup {
  arms: Map<string, ArmRollup>;
  traceIds: Set<string>;
  armsByTrace: Map<string, Set<string>>;
}

// JS mirror of the SQL roll-ups the single-scan detection query replaces:
// per-arm trace counts + span bounds, per-experiment distinct-trace counts, and
// the count of traces spanning more than one arm. Nested maps keep grouping on
// the real `(experiment, arm, trace)` tuples — never a flattened string key,
// which free-form experiment/arm names could collide on. Output order matches
// the old queries: `experimentName asc, arm asc` for arm aggregates and
// `experimentName asc` for multi-arm counts.
export function foldExperimentTraceArms(
  grain: ExperimentTraceArm[],
): ExperimentDetectionAggregates {
  const experiments = new Map<string, ExperimentRollup>();
  for (const row of grain) {
    rollUp(experimentRollup(experiments, row.experimentName), row);
  }

  const armAggregates: ExperimentArmAggregate[] = [];
  const multiArmCounts: MultiArmTraceCount[] = [];
  for (const experimentName of sortedKeys(experiments)) {
    const experiment = experiments.get(experimentName)!;
    for (const arm of sortedKeys(experiment.arms)) {
      const rollup = experiment.arms.get(arm)!;
      armAggregates.push({
        experimentName,
        arm,
        traceCount: rollup.traceIds.size,
        experimentTraceCount: experiment.traceIds.size,
        firstSeenAt: rollup.firstSeenAt,
        lastSeenAt: rollup.lastSeenAt,
      });
    }
    const multiArmTraceCount = countMultiArmTraces(experiment.armsByTrace);
    if (multiArmTraceCount > 0) {
      multiArmCounts.push({ experimentName, traceCount: multiArmTraceCount });
    }
  }
  return { armAggregates, multiArmCounts };
}

function experimentRollup(
  experiments: Map<string, ExperimentRollup>,
  experimentName: string,
): ExperimentRollup {
  const existing = experiments.get(experimentName);
  if (existing) return existing;
  const created: ExperimentRollup = {
    arms: new Map(),
    traceIds: new Set(),
    armsByTrace: new Map(),
  };
  experiments.set(experimentName, created);
  return created;
}

function rollUp(experiment: ExperimentRollup, row: ExperimentTraceArm) {
  experiment.traceIds.add(row.traceId);

  const armsForTrace = experiment.armsByTrace.get(row.traceId) ?? new Set();
  armsForTrace.add(row.arm);
  experiment.armsByTrace.set(row.traceId, armsForTrace);

  const arm = experiment.arms.get(row.arm);
  if (!arm) {
    experiment.arms.set(row.arm, {
      traceIds: new Set([row.traceId]),
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
    });
    return;
  }
  arm.traceIds.add(row.traceId);
  if (row.firstSeenAt < arm.firstSeenAt) arm.firstSeenAt = row.firstSeenAt;
  if (row.lastSeenAt > arm.lastSeenAt) arm.lastSeenAt = row.lastSeenAt;
}

function countMultiArmTraces(armsByTrace: Map<string, Set<string>>): number {
  let count = 0;
  for (const arms of armsByTrace.values()) {
    if (arms.size > 1) count += 1;
  }
  return count;
}

function sortedKeys(map: Map<string, unknown>): string[] {
  return [...map.keys()].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}
