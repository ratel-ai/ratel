import type { Compared } from "./baseline";
import { type CaseStatus, compare, statusOf, type Verdict } from "./domain/compare";
import type { Counts, Trial } from "./domain/experiment";
import { pairedTrials } from "./domain/paired-trials";
import {
  caseScores,
  deltaKey,
  type EvalDelta,
  type EvalScore,
  evalDeltas,
  evalScores,
  type ScorerScore,
} from "./domain/suite";

/**
 * The read models of a run as a suite (decision `suite-table`): one row for each eval, one eval
 * with its cases, and one trial next to the baseline trial of the same row. Plain data: the pages,
 * the API and the MCP operations show it.
 */

export type SuiteVerdict =
  | { ok: true; verdict: Verdict; rule: string; excludedMessage: string | null }
  | { ok: false; reason: string; message: string };

export type SuiteRow = EvalScore & {
  /** Null when there is no baseline run to compare with. */
  delta: EvalDelta | null;
};

export type SuiteTable = {
  runId: string;
  state: Compared["experiment"]["state"];
  sandboxName: string;
  createdAt: string;
  /** The run that the deltas compare with. Null: no baseline, or this run is the baseline. */
  baselineId: string | null;
  /** The run verdict over the cases of all evals. Null with no baseline. */
  verdict: SuiteVerdict | null;
  /** The names of the scorers of all evals, each one time, in order. */
  scorerColumns: string[];
  rows: SuiteRow[];
};

export type CaseScoreRow = {
  caseId: string;
  name: string;
  versionId: string;
  number: number;
  status: CaseStatus;
  counts: Counts;
  scorers: ScorerScore[];
  /** The same case in the baseline run. Null when it is not there. */
  baseline: { status: CaseStatus; counts: Counts; scorers: ScorerScore[] } | null;
};

export type EvalDetail = { row: SuiteRow; cases: CaseScoreRow[] };

export type PairedTrial = {
  caseId: string;
  caseName: string;
  evalId: string | null;
  trial: Trial;
  /** The trial of the same row and index in the baseline run. Null when there is none. */
  baselineTrial: Trial | null;
  baselineId: string | null;
};

/** Each eval of the run with its score, its scorers and its delta against the baseline. */
export function suiteTable(candidate: Compared, baseline: Compared | null): SuiteTable {
  const other = baseline && baseline.experiment.id !== candidate.experiment.id ? baseline : null;
  const deltas = other ? evalDeltas(other, candidate) : null;
  const rows = evalScores(candidate).map((score) => ({
    ...score,
    delta: deltas?.get(deltaKey(score)) ?? null,
  }));
  const { experiment } = candidate;
  return {
    runId: experiment.id,
    state: experiment.state,
    sandboxName: experiment.sandboxName,
    createdAt: experiment.createdAt.toISOString(),
    baselineId: other?.experiment.id ?? null,
    verdict: other ? verdictOf(other, candidate) : null,
    scorerColumns: [...new Set(rows.flatMap(({ scorers }) => scorers.map(({ name }) => name)))],
    rows,
  };
}

/** One eval of the run (`deltaKey`): its row, and each case with a breakdown for each scorer. */
export function evalDetail(
  candidate: Compared,
  baseline: Compared | null,
  key: string,
): EvalDetail | null {
  const row = suiteTable(candidate, baseline).rows.find((one) => deltaKey(one) === key);
  if (!row) return null;
  const before = new Map(
    baseline && baseline.experiment.id !== candidate.experiment.id
      ? caseScores(baseline, key).map(({ frozen, score }) => [frozen.caseId, score])
      : [],
  );
  const cases = caseScores(candidate, key).map(({ frozen, score }): CaseScoreRow => {
    const old = before.get(frozen.caseId);
    return {
      caseId: frozen.caseId,
      name: frozen.name,
      versionId: frozen.versionId,
      number: frozen.number,
      status: statusOf(score.counts),
      counts: score.counts,
      scorers: score.scorers,
      baseline: old
        ? { status: statusOf(old.counts), counts: old.counts, scorers: old.scorers }
        : null,
    };
  });
  return { row, cases };
}

/** One trial of the run, next to the trial of the same case and index in the baseline run. */
export function pairedTrial(
  candidate: Compared,
  baseline: Compared | null,
  trialId: string,
): PairedTrial | null {
  const trial = candidate.trials.find(({ id }) => id === trialId);
  const frozen = candidate.experiment.caseVersions.find(
    ({ versionId }) => versionId === trial?.caseVersionId,
  );
  if (!trial || !frozen) return null;
  const old = baseline?.experiment.caseVersions.find(({ caseId }) => caseId === frozen.caseId);
  const oldTrials = old
    ? (baseline?.trials ?? []).filter(({ caseVersionId }) => caseVersionId === old.versionId)
    : [];
  const pair = pairedTrials(oldTrials, [trial]).find(({ index }) => index === trial.index);
  return {
    caseId: frozen.caseId,
    caseName: frozen.name,
    evalId: frozen.evalId ?? null,
    trial,
    baselineTrial: pair?.baseline ?? null,
    baselineId: old ? (baseline?.experiment.id ?? null) : null,
  };
}

function verdictOf(baseline: Compared, candidate: Compared): SuiteVerdict {
  const result = compare(baseline, candidate);
  return result.ok
    ? {
        ok: true,
        verdict: result.verdict,
        rule: result.rule,
        excludedMessage: result.excludedMessage,
      }
    : { ok: false, reason: result.reason, message: result.message };
}
