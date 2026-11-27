import { DIFFERENCE, type ScorerChange, scorerChanges } from "./compare";
import {
  type Counts,
  countTrials,
  type Experiment,
  type FrozenCase,
  type Trial,
} from "./experiment";
import type { ScorerSnapshot } from "./score";

/**
 * The score of each eval of a run, and its delta against the baseline run (decision
 * `suite-table`). The score of an eval is the mean of its scorer pass rates. A pass rate counts the
 * valid trials (`pass` or `fail`) where the scorer gave a result: an invalid trial, an open trial
 * and a scorer that could not run are counted, not rated.
 */

/** A run as the scores read it. */
export type ScoredRun = {
  experiment: Pick<
    Experiment,
    "id" | "state" | "caseVersions" | "evalVersions" | "scorerSnapshots"
  >;
  trials: ReadonlyArray<Pick<Trial, "caseVersionId" | "result" | "scorers">>;
};

export type ScorerScore = {
  scorerId: string;
  name: string;
  gating: boolean;
  /** The content hash of the scorer: it pairs a scorer of two runs. */
  hash: string;
  pass: number;
  fail: number;
  notScored: number;
  /** Null when no valid trial has a result of the scorer. */
  passRate: number | null;
};

export type EvalScore = {
  /** Null: the cases of a run from before evals had definitions, as one group. */
  evalId: string | null;
  name: string;
  /** The eval version that the run froze. */
  number: number | null;
  cases: number;
  counts: Counts;
  /** Null when no scorer has a pass rate. */
  score: number | null;
  scorers: ScorerScore[];
};

export type DeltaRefusal = "not_in_baseline" | "scorers_differ";
export type EvalDelta =
  | { ok: true; score: number | null; scorers: Array<{ scorerId: string; delta: number | null }> }
  | { ok: false; reason: DeltaRefusal; message: string; changes: ScorerChange[] };

export const LEGACY_GROUP = "All cases";
/** The key of the group of a run from before evals had definitions. */
const LEGACY_KEY = "";

/** In the order of the run. */
export function evalScores(run: ScoredRun): EvalScore[] {
  return evalGroups(run.experiment).map((group) => scoreOf(group, run.trials));
}

/** The delta of each eval of the candidate, by its id (`""` for a run with no eval). */
export function evalDeltas(baseline: ScoredRun, candidate: ScoredRun): Map<string, EvalDelta> {
  const before = new Map(evalGroups(baseline.experiment).map((group) => [group.key, group]));
  const legacyBaseline = baseline.experiment.evalVersions.length === 0;
  return new Map(
    evalGroups(candidate.experiment).map((group) => {
      const old = before.get(group.key);
      if (!old) return [group.key, missing(legacyBaseline)];
      const changes = scorerChanges(sideOf(old, baseline), sideOf(group, candidate));
      if (changes.length > 0) return [group.key, differ(changes)];
      return [group.key, deltaOf(scoreOf(old, baseline.trials), scoreOf(group, candidate.trials))];
    }),
  );
}

/** Each case of one eval (by `deltaKey`), with the scores of its own trials, in the order of the run. */
export function caseScores(
  run: ScoredRun,
  key: string,
): Array<{ frozen: FrozenCase; score: EvalScore }> {
  const group = evalGroups(run.experiment).find((one) => one.key === key);
  if (!group) return [];
  return group.cases.map((frozen) => ({
    frozen,
    score: scoreOf(
      { ...group, cases: [frozen], snapshots: group.ofCase[frozen.versionId] ?? group.snapshots },
      run.trials,
    ),
  }));
}

/** The key of an eval score in the map of `evalDeltas`. */
export function deltaKey({ evalId }: Pick<EvalScore, "evalId">): string {
  return evalId ?? LEGACY_KEY;
}

type Group = {
  key: string;
  evalId: string | null;
  name: string;
  number: number | null;
  cases: FrozenCase[];
  snapshots: ScorerSnapshot[];
  /** The scorers that each case version froze: a trial reports the scorer ids of its own case. */
  ofCase: ScoredRun["experiment"]["scorerSnapshots"];
};

function evalGroups(experiment: ScoredRun["experiment"]): Group[] {
  const { caseVersions, evalVersions, scorerSnapshots } = experiment;
  const snapshotsOf = (cases: FrozenCase[]) => scorerSnapshots[cases[0]?.versionId ?? ""] ?? [];
  if (evalVersions.length === 0) {
    if (caseVersions.length === 0) return [];
    // An old run: the scorers were the case's, each with its own ids.
    return [
      {
        key: LEGACY_KEY,
        evalId: null,
        name: LEGACY_GROUP,
        number: null,
        cases: [...caseVersions],
        snapshots: sharedSnapshots(caseVersions, scorerSnapshots),
        ofCase: scorerSnapshots,
      },
    ];
  }
  const byEval = Map.groupBy(caseVersions, ({ evalId }) => evalId ?? LEGACY_KEY);
  return evalVersions.map(({ evalId, name, number }) => {
    const cases = byEval.get(evalId) ?? [];
    return {
      key: evalId,
      evalId,
      name,
      number,
      cases,
      snapshots: snapshotsOf(cases),
      ofCase: scorerSnapshots,
    };
  });
}

/** The scorers of the first case when each case has the same scorers, else none: no score. */
function sharedSnapshots(
  cases: readonly FrozenCase[],
  ofCase: ScoredRun["experiment"]["scorerSnapshots"],
): ScorerSnapshot[] {
  const keys = (versionId: string) => (ofCase[versionId] ?? []).map(pairKey).sort().join("\n");
  const first = cases[0]?.versionId ?? "";
  const same = cases.every(({ versionId }) => keys(versionId) === keys(first));
  return same ? (ofCase[first] ?? []) : [];
}

function scoreOf(group: Group, allTrials: ScoredRun["trials"]): EvalScore {
  const versions = new Set(group.cases.map(({ versionId }) => versionId));
  const trials = allTrials.filter(({ caseVersionId }) => versions.has(caseVersionId));
  const valid = trials.filter(({ result }) => result === "pass" || result === "fail");
  const scorers = group.snapshots.map((snapshot): ScorerScore => {
    const { id, name, gating, hash } = snapshot;
    let [pass, fail, notScored] = [0, 0, 0];
    for (const trial of valid) {
      const own = group.ofCase[trial.caseVersionId]?.find(
        (one) => pairKey(one) === pairKey(snapshot),
      );
      const status = trial.scorers.find(({ scorerId }) => scorerId === (own?.id ?? id))?.status;
      if (status === "pass") pass += 1;
      else if (status === "fail") fail += 1;
      else notScored += 1;
    }
    const rated = pass + fail;
    return {
      scorerId: id,
      name,
      gating,
      hash,
      pass,
      fail,
      notScored,
      passRate: rated > 0 ? pass / rated : null,
    };
  });
  return {
    evalId: group.evalId,
    name: group.name,
    number: group.number,
    cases: group.cases.length,
    counts: countTrials(trials),
    score: mean(scorers.map(({ passRate }) => passRate)),
    scorers,
  };
}

/** The score delta is the mean delta of the scorers rated on both sides. */
function deltaOf(baseline: EvalScore, candidate: EvalScore): EvalDelta {
  const before = new Map(baseline.scorers.map((scorer) => [pairKey(scorer), scorer]));
  const scorers = candidate.scorers.map((scorer) => ({
    scorerId: scorer.scorerId,
    delta: minus(scorer.passRate, before.get(pairKey(scorer))?.passRate ?? null),
  }));
  return { ok: true, score: mean(scorers.map(({ delta }) => delta)), scorers };
}

function sideOf(group: Group, run: ScoredRun) {
  return {
    snapshots: group.snapshots,
    trials: run.trials,
    versionIds: new Set(group.cases.map(({ versionId }) => versionId)),
  };
}

function missing(legacyBaseline: boolean): EvalDelta {
  const message = legacyBaseline
    ? "The baseline run is from before evals had definitions. Pin a newer run as the baseline."
    : "The baseline run did not run this eval. Pin a run that has it.";
  return { ok: false, reason: "not_in_baseline", message, changes: [] };
}

function differ(changes: ScorerChange[]): EvalDelta {
  const words = changes.map(({ name, difference }) => `"${name}" (${DIFFERENCE[difference]})`);
  const message = `The scorers of this eval differ from the baseline: ${words.join(", ")}. Run the baseline again with the present scorers and pin it. If the judge model changed during this run, run it again too.`;
  return { ok: false, reason: "scorers_differ", message, changes };
}

/** Two scorers with the same content and the same gating are one scorer. With no hash, the name. */
function pairKey({ hash, name, gating }: Pick<ScorerScore, "hash" | "name" | "gating">): string {
  return hash ? `${hash}:${gating}` : `name:${name}:${gating}`;
}

function mean(values: ReadonlyArray<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length > 0 ? known.reduce((sum, value) => sum + value, 0) / known.length : null;
}

function minus(after: number | null, before: number | null): number | null {
  return after === null || before === null ? null : after - before;
}
