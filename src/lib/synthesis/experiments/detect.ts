import type { ExperimentArmAggregate, ExperimentSummary, MultiArmTraceCount } from "./types";

export function detectExperiments(
  armAggregates: ExperimentArmAggregate[],
  multiArmCounts: MultiArmTraceCount[],
): ExperimentSummary[] {
  const aggregatesByExperiment = new Map<string, ExperimentArmAggregate[]>();
  const multiArmCountByExperiment = new Map(
    multiArmCounts.map((count) => [count.experimentName, count.traceCount]),
  );

  for (const aggregate of armAggregates) {
    const experimentAggregates = aggregatesByExperiment.get(aggregate.experimentName) ?? [];
    experimentAggregates.push(aggregate);
    aggregatesByExperiment.set(aggregate.experimentName, experimentAggregates);
  }

  return [...aggregatesByExperiment]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([name, aggregates]) => {
      const sortedAggregates = [...aggregates].sort((left, right) =>
        compareStrings(left.arm, right.arm),
      );
      const traceCount = aggregates[0].experimentTraceCount;
      const multiArmTraceCount = multiArmCountByExperiment.get(name) ?? 0;

      return {
        name,
        mode:
          multiArmTraceCount === 0
            ? "split"
            : multiArmTraceCount === traceCount
              ? "shadow"
              : "mixed",
        baselineArm: pickBaselineArm(sortedAggregates.map((aggregate) => aggregate.arm)),
        traceCount,
        multiArmTraceCount,
        arms: sortedAggregates.map((aggregate) => ({
          arm: aggregate.arm,
          traceCount: aggregate.traceCount,
          traceShare: aggregate.traceCount / traceCount,
        })),
        firstSeenAt: new Date(
          Math.min(...aggregates.map((aggregate) => aggregate.firstSeenAt.getTime())),
        ),
        lastSeenAt: new Date(
          Math.max(...aggregates.map((aggregate) => aggregate.lastSeenAt.getTime())),
        ),
      };
    });
}

export function pickBaselineArm(arms: string[]): string {
  return (
    arms.find((arm) => arm.toLowerCase() === "control") ??
    arms.find((arm) => arm.toLowerCase() === "baseline") ??
    arms.find((arm) => arm.toLowerCase() === "a") ??
    [...arms].sort()[0] ??
    ""
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
