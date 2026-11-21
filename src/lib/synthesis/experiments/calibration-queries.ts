import type { getDb } from "@/lib/platform/db/client";
import {
  countExperimentComparisons,
  countRankingComparisons,
  getRankingComparisonSummary,
  listRankingComparisons,
} from "@/lib/synthesis/traces/experiment-calibration-queries";
import { listExperimentLifecycleArmMetrics } from "@/lib/synthesis/traces/experiment-lifecycle-queries";
import type { CalibrationQueries } from "./calibration-service";

type CalibrationQueriesDb = Pick<ReturnType<typeof getDb>, "select">;

/** Bind the otel_logs-backed calibration reads to one (bounded) connection. */
export function createCalibrationQueries(db?: CalibrationQueriesDb): CalibrationQueries {
  return {
    countExperimentComparisons: (projectId, experimentNames, window) =>
      countExperimentComparisons(projectId, experimentNames, window, db),
    getRankingComparisonSummary: (projectId, experimentName, window) =>
      getRankingComparisonSummary(projectId, experimentName, window, db),
    countRankingComparisons: (projectId, experimentName, window, options) =>
      countRankingComparisons(projectId, experimentName, window, options, db),
    listRankingComparisons: (projectId, experimentName, window, options) =>
      listRankingComparisons(projectId, experimentName, window, options, db),
    listExperimentLifecycleArmMetrics: (projectId, experimentName, window) =>
      listExperimentLifecycleArmMetrics(projectId, experimentName, window, db),
  };
}
