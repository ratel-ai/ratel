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
  | {
      ok: true;
      /** The pin of the baseline side. Null when the reader chose an experiment that is not pinned. */
      pin: Baseline | null;
      baseline: Compared;
      candidate: Compared;
      comparison: Comparison;
    }
  | {
      ok: false;
      refusal: Omit<CompareRefusal, "ok" | "reason"> & {
        reason: CompareRefusal["reason"] | "not_found" | "no_baseline";
        /** The pin of the other side. Null: it is not the pinned baseline, or none is pinned. */
        pin: Baseline | null;
        /** The experiment of the other side. Null when there is none to compare with. */
        otherId: string | null;
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

/**
 * An experiment against another one: the experiment that the reader chose, else the pinned baseline
 * of the project. The verdict and the refusals are the same for both.
 */
export async function compareWithBaseline(
  projectId: string,
  experimentId: string,
  deps: BaselineDeps,
  baselineId: string | null = null,
): Promise<ComparisonResult> {
  const candidate = await find(projectId, experimentId, deps);
  if (!candidate) return refused("not_found", "There is no such experiment.");
  const pinned = await deps.baselines.get(projectId);
  const otherId = baselineId ?? pinned?.experimentId ?? null;
  const other = otherId === null ? null : await find(projectId, otherId, deps);
  if (!other) {
    return baselineId === null
      ? refused("no_baseline", "The project has no pinned baseline. Pin an experiment first.")
      : refused("not_found", "There is no such experiment to compare with.");
  }
  const pin = pinned?.experimentId === other.id ? pinned : null;
  const [baselineTrials, candidateTrials] = await Promise.all([
    deps.experiments.trials(other.id),
    deps.experiments.trials(candidate.id),
  ]);
  const sides = {
    baseline: { experiment: other, trials: baselineTrials },
    candidate: { experiment: candidate, trials: candidateTrials },
  };
  const comparison = compare(sides.baseline, sides.candidate);
  if (!comparison.ok) {
    const { ok: _, ...refusal } = comparison;
    return { ok: false, refusal: { ...refusal, pin, otherId: other.id } };
  }
  return { ok: true, pin, ...sides, comparison };
}

/** The pinned baseline run with its trials. Null when none is pinned. */
export async function pinnedRun(projectId: string, deps: BaselineDeps): Promise<Compared | null> {
  const pinned = await deps.baselines.get(projectId);
  const experiment = pinned && (await deps.experiments.get(projectId, pinned.experimentId));
  if (!experiment) return null;
  return { experiment, trials: await deps.experiments.trials(experiment.id) };
}

async function find(projectId: string, experimentId: string, { experiments }: BaselineDeps) {
  return z.uuid().safeParse(experimentId).success ? experiments.get(projectId, experimentId) : null;
}

function refused(reason: "not_found" | "no_baseline", message: string): ComparisonResult {
  return { ok: false, refusal: { reason, message, scorers: [], pin: null, otherId: null } };
}
