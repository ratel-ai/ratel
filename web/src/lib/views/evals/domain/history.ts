import type { Counts, Experiment, Trial } from "./experiment";
import { countTrials, sameVariant, variantsOf } from "./experiment";
import type { MatrixValue } from "./matrix";
import { type EvalScore, evalDeltas, evalScores, type ScorerScore } from "./suite";

/**
 * The score of one eval in one run (decision `runs-per-eval`). Each variant (a combination of the
 * matrix) has the score of `suite.ts`: the mean pass rate of its scorers over its valid trials. The
 * score of the run is the mean of the scores of its variants. A run with no matrix has one variant,
 * so its score is the score of `suite.ts`. A suite run from before has the eval as one of its evals.
 *
 * The delta of a variant is its score minus the score of the variant with the same values in the
 * baseline run. The delta of the run is its score minus the score of the baseline run. There is no
 * delta when the scorers differ from the baseline (`scorers_differ`), or when the baseline did not
 * run the eval or the variant (`not_in_baseline`): the reason says why.
 */

export type ScoredRunOf = {
  experiment: Pick<
    Experiment,
    | "id"
    | "state"
    | "caseVersions"
    | "evalVersions"
    | "scorerSnapshots"
    | "variants"
    | "params"
    | "createdAt"
  >;
  trials: ReadonlyArray<Pick<Trial, "caseVersionId" | "result" | "scorers" | "variant">>;
};

export type NoDelta = { reason: "scorers_differ" | "not_in_baseline"; message: string };
export type Delta = { score: number | null } | NoDelta;

export type VariantScore = {
  index: number;
  values: Record<string, MatrixValue>;
  params: Record<string, unknown>;
  counts: Counts;
  /** Null when no scorer has a pass rate. */
  score: number | null;
  scorers: ScorerScore[];
  /** Null with no baseline run. */
  delta: Delta | null;
};

export type RunScore = {
  /** The mean of the scores of the variants. Null when no variant has a score. */
  score: number | null;
  /** All the trials of the run. */
  counts: Counts;
  /** Each scorer over all the trials of the run (each variant). */
  scorers: ScorerScore[];
  variants: VariantScore[];
  /** Null with no baseline run, or when this run is the baseline. */
  delta: Delta | null;
};

/** The score of the eval in the run. Null when the run did not run the eval. */
export function runScore(
  run: ScoredRunOf,
  evalId: string,
  baseline: ScoredRunOf | null = null,
): RunScore | null {
  const all = scoreIn(run, run.trials, evalId);
  if (!all) return null;
  const other = baseline && baseline.experiment.id !== run.experiment.id ? baseline : null;
  const differ = other ? refusalOf(other, run, evalId) : null;
  const otherVariants = other ? variantsOf(other.experiment) : [];
  const variants = variantsOf(run.experiment).map((variant): VariantScore => {
    const own = scoreIn(run, trialsOf(run, variant.index), evalId);
    const score = own?.score ?? null;
    let delta: Delta | null = null;
    if (other) {
      const before = sameVariant(variant, otherVariants);
      const baseScore = before ? scoreIn(other, trialsOf(other, before.index), evalId) : null;
      delta =
        differ ??
        (baseScore
          ? { score: minus(score, baseScore.score) }
          : {
              reason: "not_in_baseline",
              message: "The baseline run did not run these values of the matrix.",
            });
    }
    return {
      index: variant.index,
      values: variant.values,
      params: variant.params,
      counts: own?.counts ?? countTrials([]),
      score,
      scorers: own?.scorers ?? [],
      delta,
    };
  });
  const score = mean(variants.map((variant) => variant.score));
  let delta: Delta | null = null;
  if (other) {
    const before = runScore(other, evalId);
    delta =
      differ ??
      (before
        ? { score: minus(score, before.score) }
        : { reason: "not_in_baseline", message: "The baseline run did not run this eval." });
  }
  return { score, counts: all.counts, scorers: all.scorers, variants, delta };
}

function trialsOf(run: ScoredRunOf, variant: number): ScoredRunOf["trials"] {
  return run.trials.filter((trial) => (trial.variant ?? 0) === variant);
}

function scoreIn(
  run: ScoredRunOf,
  trials: ScoredRunOf["trials"],
  evalId: string,
): EvalScore | null {
  return (
    evalScores({ experiment: run.experiment, trials }).find((one) => one.evalId === evalId) ?? null
  );
}

/** Why the eval of the run has no delta against the baseline, from its scorers, or null. */
function refusalOf(baseline: ScoredRunOf, run: ScoredRunOf, evalId: string): NoDelta | null {
  const delta = evalDeltas(baseline, run).get(evalId);
  if (!delta || delta.ok) return null;
  return delta.reason === "scorers_differ" ? { reason: delta.reason, message: delta.message } : null;
}

export function mean(values: ReadonlyArray<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length > 0 ? known.reduce((sum, value) => sum + value, 0) / known.length : null;
}

function minus(after: number | null, before: number | null): number | null {
  return after === null || before === null ? null : after - before;
}
