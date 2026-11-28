import type { Compared } from "./baseline";
import {
  type CaseChange,
  type CaseStatus,
  type CompareRefusal,
  type Comparison,
  compare,
  statusOf,
  type Verdict,
} from "./domain/compare";
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
 * The read models of a run as a suite (decision `suite-table`): one row for each eval, and one
 * trial next to the baseline trial of the same row. Plain data: the pages,
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
  const other = otherRun(candidate, baseline);
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
    verdict: other ? verdictOf(compare(other, candidate)) : null,
    scorerColumns: [...new Set(rows.flatMap(({ scorers }) => scorers.map(({ name }) => name)))],
    rows,
  };
}

/**
 * One trial of the run, next to the trial of the same row, variant and index in the baseline run.
 * The variant of the baseline is the one with the same params, else its first.
 */
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
  const other = otherRun(candidate, baseline);
  const old = other?.experiment.caseVersions.find(({ caseId }) => caseId === frozen.caseId);
  const params = JSON.stringify(
    candidate.experiment.variants.find(({ index }) => index === trial.variant)?.params ?? {},
  );
  const variant =
    other?.experiment.variants.find((one) => JSON.stringify(one.params) === params)?.index ?? 0;
  const oldTrials = old
    ? (other?.trials ?? []).filter(
        (one) => one.caseVersionId === old.versionId && (one.variant ?? 0) === variant,
      )
    : [];
  const pair = pairedTrials(oldTrials, [trial]).find(({ index }) => index === trial.index);
  return {
    caseId: frozen.caseId,
    caseName: frozen.name,
    evalId: frozen.evalId ?? candidate.experiment.evalId ?? null,
    trial,
    baselineTrial: pair?.baseline ?? null,
    baselineId: pair?.baseline ? (other?.experiment.id ?? null) : null,
  };
}

/** The baseline run, unless it is the candidate run itself. */
function otherRun(candidate: Compared, baseline: Compared | null): Compared | null {
  return baseline && baseline.experiment.id !== candidate.experiment.id ? baseline : null;
}

function verdictOf(result: Comparison | CompareRefusal): SuiteVerdict {
  return result.ok
    ? {
        ok: true,
        verdict: result.verdict,
        rule: result.rule,
        excludedMessage: result.excludedMessage,
      }
    : { ok: false, reason: result.reason, message: result.message };
}
