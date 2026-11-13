import type { CalibrationQueries } from "@/lib/synthesis/experiments/calibration-service";

/**
 * The calibration service reads its aggregates in parallel. Inside one
 * statement-timeout transaction they all share a single client, and pg warns
 * that overlapping queries on one client are deprecated (Next shows it as a
 * dev issue). Queuing the reads keeps the timeout and gives the client one
 * query at a time; a failed read still rejects its own caller, and the queue
 * moves on.
 */
export function oneAtATime(queries: CalibrationQueries): CalibrationQueries {
  let tail: Promise<unknown> = Promise.resolve();
  function queue<A extends unknown[], R>(
    read: (...args: A) => Promise<R>,
  ): (...args: A) => Promise<R> {
    return (...args) => {
      const run = tail.then(() => read(...args));
      tail = run.catch(() => undefined);
      return run;
    };
  }
  return {
    countExperimentComparisons: queue(queries.countExperimentComparisons),
    getRankingComparisonSummary: queue(queries.getRankingComparisonSummary),
    listRankingComparisons: queue(queries.listRankingComparisons),
    countRankingComparisons: queue(queries.countRankingComparisons),
    listExperimentLifecycleArmMetrics: queue(queries.listExperimentLifecycleArmMetrics),
  };
}
