import {
  type Counts,
  countTrials,
  type Experiment,
  type FrozenCase,
  type Trial,
} from "./experiment";
import type { ScorerSnapshot, TrialResult } from "./score";

/** An experiment as a comparison reads it. */
export type ComparedRun = {
  experiment: Pick<Experiment, "id" | "state" | "caseVersions" | "scorerSnapshots">;
  trials: ReadonlyArray<Pick<Trial, "caseVersionId" | "result" | "scorers">>;
};

export type Verdict = "regressed" | "improved" | "unchanged" | "inconclusive";
/** `excluded`: the scorers of the case (of its eval) differ between the two runs. */
export type CaseChange = Verdict | "added" | "removed" | "excluded";
export type CaseStatus = TrialResult;

/** A case in one of the two experiments. */
export type CaseSide = { versionId: string; number: number; status: CaseStatus; counts: Counts };
export type ComparedCase = {
  caseId: string;
  name: string;
  change: CaseChange;
  /** Null for a case that is not in that experiment. */
  baseline: CaseSide | null;
  candidate: CaseSide | null;
};

export type ScorerDifference = {
  caseId: string;
  caseName: string;
  name: string;
  difference: "changed" | "gating" | "added" | "removed";
};

/**
 * The order of `cases`: the changes first, the worst of them at the top. `excluded` names the
 * scorers that differ, and `excludedMessage` says why their cases are not in the verdict.
 */
export type Comparison = {
  ok: true;
  verdict: Verdict;
  rule: string;
  cases: ComparedCase[];
  excluded: ScorerDifference[];
  excludedMessage: string | null;
};
export type CompareRefusal = {
  ok: false;
  reason: "same_experiment" | "not_completed" | "scorers_differ";
  message: string;
  /** Empty for the other reasons. */
  scorers: ScorerDifference[];
};

const CASE_RULE =
  "A case passes when all its valid trials pass, fails when a valid trial fails, and is invalid when no trial is valid.";
/** The rule that decided, as text. `nothing` is `inconclusive` with no case to compare. */
export const VERDICT_RULE: Record<Verdict | "nothing", string> = {
  regressed: `Regressed: a case went from pass to fail. No other case changes that. ${CASE_RULE}`,
  improved: `Improved: a case went from fail to pass, none went from pass to fail, and no compared case is invalid. ${CASE_RULE}`,
  unchanged: `Unchanged: no case went from pass to fail or from fail to pass, and no compared case is invalid. ${CASE_RULE}`,
  inconclusive: `Inconclusive: a compared case is invalid, and no case went from pass to fail. ${CASE_RULE}`,
  nothing: "Inconclusive: no case is in both experiments, so there is nothing to compare.",
};

/** `scorers` has all of them. The message names the first ones. */
const NAMED_SCORERS = 3;
/** The changes of a case that is in both runs and has the same scorers in both. */
const SHARED = new Set<CaseChange>(["regressed", "improved", "unchanged", "inconclusive"]);
const CHANGE_ORDER: CaseChange[] = [
  "regressed",
  "inconclusive",
  "improved",
  "added",
  "removed",
  "excluded",
  "unchanged",
];

/** The candidate against the baseline. Cases are matched by id. */
export function compare(
  baseline: ComparedRun,
  candidate: ComparedRun,
): Comparison | CompareRefusal {
  if (baseline.experiment.id === candidate.experiment.id) {
    return refused("same_experiment", "This experiment is the baseline. Compare another one.");
  }
  if ([baseline, candidate].some(({ experiment }) => experiment.state !== "completed")) {
    return refused(
      "not_completed",
      "An experiment has not ended. Compare it when it is completed.",
    );
  }
  const scorers = scorerDifferences(baseline, candidate);
  const excludedIds = new Set(scorers.map(({ caseId }) => caseId));
  const cases = comparedCases(baseline, candidate, excludedIds);
  const message = scorers.length > 0 ? differMessage(scorers) : null;
  if (message && !cases.some(({ change }) => SHARED.has(change))) {
    return { ...refused("scorers_differ", message), scorers };
  }
  const { verdict, rule } = decide(cases);
  return { ok: true, verdict, rule, cases, excluded: scorers, excludedMessage: message };
}

/**
 * Why the cases of some evals are not compared. When no case is left, the comparison is refused
 * with this message.
 */
export function differMessage(scorers: readonly ScorerDifference[]): string {
  const words = scorers
    .slice(0, NAMED_SCORERS)
    .map(
      ({ caseName, name, difference }) => `"${name}" of "${caseName}" (${DIFFERENCE[difference]})`,
    );
  const others = scorers.length - words.length;
  if (others > 0) words.push(`and ${others} more`);
  return `The scorers of the two experiments differ: ${words.join(", ")}. Run the baseline again with the present scorers and pin it. If the judge model changed during this run, run it again too.`;
}

export function changedCases({ cases }: Pick<Comparison, "cases">): ComparedCase[] {
  return cases.filter(({ change }) => change !== "unchanged");
}

export function otherCases({ cases }: Pick<Comparison, "cases">): ComparedCase[] {
  return cases.filter(({ change }) => change === "unchanged");
}

export const DIFFERENCE: Record<ScorerDifference["difference"], string> = {
  changed: "its definition or its judge model changed",
  gating: "gating on one side and advisory on the other",
  added: "not in the baseline",
  removed: "only in the baseline",
};

function decide(cases: readonly ComparedCase[]): { verdict: Verdict; rule: string } {
  const has = (wanted: CaseChange) => cases.some(({ change }) => change === wanted);
  if (!cases.some(({ change }) => SHARED.has(change))) {
    return { verdict: "inconclusive", rule: VERDICT_RULE.nothing };
  }
  const order = ["regressed", "inconclusive", "improved"] as const;
  const verdict = order.find(has) ?? "unchanged";
  return { verdict, rule: VERDICT_RULE[verdict] };
}

function comparedCases(
  baseline: ComparedRun,
  candidate: ComparedRun,
  excluded: ReadonlySet<string>,
): ComparedCase[] {
  const before = sides(baseline);
  const after = sides(candidate);
  const names = new Map(
    [...baseline.experiment.caseVersions, ...candidate.experiment.caseVersions].map(
      ({ caseId, name }) => [caseId, name],
    ),
  );
  return [...names]
    .map(([caseId, name]): ComparedCase => {
      const left = before.get(caseId) ?? null;
      const right = after.get(caseId) ?? null;
      const change = left && right && excluded.has(caseId) ? "excluded" : changeOf(left, right);
      return { caseId, name, change, baseline: left, candidate: right };
    })
    .sort(
      (left, right) =>
        CHANGE_ORDER.indexOf(left.change) - CHANGE_ORDER.indexOf(right.change) ||
        byText(left.name, right.name) ||
        byText(left.caseId, right.caseId),
    );
}

function sides({ experiment, trials }: ComparedRun): Map<string, CaseSide> {
  const byVersion = Map.groupBy(trials, ({ caseVersionId }) => caseVersionId);
  return new Map(
    experiment.caseVersions.map(({ caseId, versionId, number }: FrozenCase) => {
      const counts = countTrials(byVersion.get(versionId) ?? []);
      return [caseId, { versionId, number, status: statusOf(counts), counts }];
    }),
  );
}

export function statusOf({ pass, fail }: Counts): CaseStatus {
  if (fail > 0) return "fail";
  return pass > 0 ? "pass" : "invalid";
}

function changeOf(baseline: CaseSide | null, candidate: CaseSide | null): CaseChange {
  if (!baseline) return "added";
  if (!candidate) return "removed";
  if (baseline.status === "invalid" || candidate.status === "invalid") return "inconclusive";
  if (baseline.status === candidate.status) return "unchanged";
  return candidate.status === "fail" ? "regressed" : "improved";
}

/**
 * Of the cases that both experiments have. The id and the name of a scorer do not score. The model
 * of a judge does: it is a setting that can change between two experiments, and in one.
 */
function scorerDifferences(
  { experiment: baseline, trials: baselineTrials }: ComparedRun,
  { experiment: candidate, trials: candidateTrials }: ComparedRun,
): ScorerDifference[] {
  const before = new Map(baseline.caseVersions.map((frozen) => [frozen.caseId, frozen]));
  return [...candidate.caseVersions]
    .sort((left, right) => byText(left.name, right.name) || byText(left.caseId, right.caseId))
    .flatMap(({ caseId, versionId, name }) => {
      const old = before.get(caseId);
      if (!old) return [];
      const found = scorerChanges(
        {
          snapshots: baseline.scorerSnapshots[old.versionId] ?? [],
          trials: baselineTrials,
          versionIds: new Set([old.versionId]),
        },
        {
          snapshots: candidate.scorerSnapshots[versionId] ?? [],
          trials: candidateTrials,
          versionIds: new Set([versionId]),
        },
      );
      return found.map((difference) => ({ caseId, caseName: name, ...difference }));
    });
}

type Found = Pick<ScorerDifference, "name" | "difference">;

/**
 * How the scorers of one side differ from the other, with the judge models that answered. The id
 * and the name of a scorer do not count.
 */
export type ScorerChange = Found;

export function scorerChanges(
  before: {
    snapshots: readonly ScorerSnapshot[];
    trials: ComparedRun["trials"];
    versionIds: ReadonlySet<string>;
  },
  after: {
    snapshots: readonly ScorerSnapshot[];
    trials: ComparedRun["trials"];
    versionIds: ReadonlySet<string>;
  },
): Found[] {
  const found = differences([...before.snapshots], [...after.snapshots]);
  const models = new Map<string, Set<string>>();
  for (const side of [before, after]) {
    const hashes = new Map(side.snapshots.map(({ id, hash }) => [id, hash]));
    for (const trial of side.trials) {
      if (!side.versionIds.has(trial.caseVersionId)) continue;
      for (const { scorerId, model } of trial.scorers) {
        const hash = hashes.get(scorerId);
        if (!hash || !model) continue;
        models.set(hash, (models.get(hash) ?? new Set()).add(model));
      }
    }
  }
  for (const { name, hash } of after.snapshots) {
    const changed = (models.get(hash)?.size ?? 0) > 1;
    if (changed && !found.some((other) => other.name === name)) {
      found.push({ name, difference: "changed" });
    }
  }
  return found;
}

function differences(left: ScorerSnapshot[], right: ScorerSnapshot[]): Found[] {
  const before = [...left];
  const after = [...right];
  const pairs = (same: (a: ScorerSnapshot, b: ScorerSnapshot) => boolean) =>
    before.flatMap((a) => {
      const index = after.findIndex((b) => same(a, b));
      return index < 0 ? [] : [[a, ...after.splice(index, 1)] as [ScorerSnapshot, ScorerSnapshot]];
    });
  const drop = (found: Array<[ScorerSnapshot, ScorerSnapshot]>) => {
    for (const [a] of found) before.splice(before.indexOf(a), 1);
    return found;
  };
  const equal = (a: ScorerSnapshot, b: ScorerSnapshot) =>
    a.hash === b.hash && a.gating === b.gating;
  drop(pairs((a, b) => a.id === b.id && equal(a, b)));
  drop(pairs(equal));
  const changed = [
    ...drop(pairs((a, b) => a.id === b.id)),
    ...drop(pairs((a, b) => a.hash === b.hash)),
  ].map(
    ([a, b]): Found => ({ name: b.name, difference: a.hash === b.hash ? "gating" : "changed" }),
  );
  return [
    ...changed,
    ...before.map(({ name }): Found => ({ name, difference: "removed" })),
    ...after.map(({ name }): Found => ({ name, difference: "added" })),
  ];
}

/** Not `localeCompare`: the order must not depend on the machine. */
function byText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function refused(reason: CompareRefusal["reason"], message: string): CompareRefusal {
  return { ok: false, reason, message, scorers: [] };
}
