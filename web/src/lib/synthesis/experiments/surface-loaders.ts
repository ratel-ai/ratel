import { loadOrFallback, type ResilientReadDeps } from "@/lib/platform/resilient-read";
import {
  attachExperimentSupplementaryData,
  type ExperimentLifecycleData,
} from "@/lib/synthesis/experiments/service";
import type {
  ExperimentComparison,
  ExperimentConversionMetrics,
} from "@/lib/synthesis/experiments/types";

export interface ExperimentDetailSurfaceParams {
  distinctId: string;
}

export interface ExperimentDetailSurfaceDeps {
  loadComparison: () => Promise<ExperimentComparison | null>;
  loadLifecycle: () => Promise<ExperimentLifecycleData | null>;
  loadConversion: () => Promise<ExperimentConversionMetrics | null>;
  resilientReadDeps?: ResilientReadDeps;
}

export async function loadExperimentDetailSurface(
  { distinctId }: ExperimentDetailSurfaceParams,
  deps: ExperimentDetailSurfaceDeps,
): Promise<ExperimentComparison | null> {
  const [loadedComparison, lifecycle, conversion] = await Promise.all([
    deps.loadComparison(),
    loadOrFallback(
      {
        operation: "experiment_lifecycle",
        distinctId,
        fallback: null,
        load: deps.loadLifecycle,
      },
      deps.resilientReadDeps,
    ),
    loadOrFallback(
      {
        operation: "experiment_conversion",
        distinctId,
        fallback: null,
        load: deps.loadConversion,
      },
      deps.resilientReadDeps,
    ),
  ]);
  return loadedComparison
    ? attachExperimentSupplementaryData(loadedComparison, lifecycle, conversion)
    : null;
}
