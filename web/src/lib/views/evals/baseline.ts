import { z } from "zod";
import { type CompareRefusal, type Comparison, compare } from "./domain/compare";
import type { Experiment, Trial } from "./domain/experiment";
import type { Baseline, BaselineStore } from "./ports/baseline-store";
import type { ExperimentStore } from "./ports/experiment-store";

export type BaselineDeps = {
  baselines: BaselineStore;
  experiments: Pick<ExperimentStore, "get" | "trials">;
  now: () => Date;
};

export type PinResult =
  | { ok: true; baseline: Baseline }
  | { ok: false; reason: "not_found" | "not_completed"; message: string };

/** One of the two experiments, with what its trials did. */
export type Compared = { experiment: Experiment; trials: Trial[] };
export type ComparisonResult =
  | { ok: true; pin: Baseline; baseline: Compared; candidate: Compared; comparison: Comparison }
  | {
      ok: false;
      refusal: Omit<CompareRefusal, "ok" | "reason"> & {
        reason: CompareRefusal["reason"] | "not_found" | "no_baseline";
      };
    };

/** A person makes a completed experiment the baseline of its project. */
export async function pinBaseline(
  projectId: string,
  experimentId: string,
  pinnedBy: string,
  deps: BaselineDeps,
): Promise<PinResult> {
  const experiment = await find(projectId, experimentId, deps);
  if (!experiment) {
    return { ok: false, reason: "not_found", message: "There is no such experiment." };
  }
  if (experiment.state !== "completed") {
    const message = "The experiment has not ended. Pin it when it is completed.";
    return { ok: false, reason: "not_completed", message };
  }
  const baseline = { experimentId: experiment.id, pinnedBy, pinnedAt: deps.now() };
  await deps.baselines.pin(projectId, baseline);
  return { ok: true, baseline };
}

/** An experiment against the pinned baseline of its project. */
export async function compareWithBaseline(
  projectId: string,
  experimentId: string,
  deps: BaselineDeps,
): Promise<ComparisonResult> {
  const candidate = await find(projectId, experimentId, deps);
  if (!candidate) return refused("not_found", "There is no such experiment.");
  const pin = await deps.baselines.get(projectId);
  const pinned = pin && (await deps.experiments.get(projectId, pin.experimentId));
  if (!pin || !pinned) {
    return refused("no_baseline", "The project has no pinned baseline. Pin an experiment first.");
  }
  const [baselineTrials, candidateTrials] = await Promise.all([
    deps.experiments.trials(pinned.id),
    deps.experiments.trials(candidate.id),
  ]);
  const sides = {
    baseline: { experiment: pinned, trials: baselineTrials },
    candidate: { experiment: candidate, trials: candidateTrials },
  };
  const comparison = compare(sides.baseline, sides.candidate);
  if (!comparison.ok) {
    const { ok: _, ...refusal } = comparison;
    return { ok: false, refusal };
  }
  return { ok: true, pin, ...sides, comparison };
}

async function find(projectId: string, experimentId: string, { experiments }: BaselineDeps) {
  return z.uuid().safeParse(experimentId).success ? experiments.get(projectId, experimentId) : null;
}

function refused(reason: "not_found" | "no_baseline", message: string): ComparisonResult {
  return { ok: false, refusal: { reason, message, scorers: [] } };
}
