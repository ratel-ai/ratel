import {
  type Counts,
  countTrials,
  type Experiment,
  type FrozenCase,
  type Trial,
} from "./domain/experiment";
import type { SuiteTable } from "./suite-view";

/** One case of an experiment with its raw counts. */
export type CaseCounts = FrozenCase & { counts: Counts };

/**
 * The wire shape (`protocol/evals/v1/experiment.schema.json`). It has no captured text: no output,
 * no tool call and no scorer reason. The experiment page shows them to a member. With the suite,
 * it also has each eval with its score and its delta against the baseline, and the verdict.
 */
export function experimentView(
  experiment: Experiment,
  trials: readonly Trial[],
  url: string,
  suite: SuiteTable | null = null,
) {
  const byCase = trialsByCase(trials);
  return {
    v: 1 as const,
    experimentId: experiment.id,
    state: experiment.state,
    url,
    sandboxVersionId: experiment.sandboxVersionId,
    git: { commit: experiment.gitCommit, dirty: experiment.gitDirty },
    params: experiment.params,
    trialsPerCase: experiment.trialsPerCase,
    counts: countTrials(trials),
    cases: caseCounts(experiment, trials).map(({ counts, ...frozen }) => ({
      caseId: frozen.caseId,
      caseVersionId: frozen.versionId,
      number: frozen.number,
      name: frozen.name,
      counts,
      trials: (byCase.get(frozen.versionId) ?? []).map((trial) => ({
        trialId: trial.id,
        index: trial.index,
        result: trial.result,
        reason: trial.result === "invalid" ? trial.reason : null,
        traceId: trial.traceId,
        sandboxRunId: trial.sandboxRunId,
        scorers: trial.scorers.map(({ name, gating, status }) => ({ name, gating, status })),
      })),
    })),
    ...(suite ? suiteFields(suite) : {}),
    createdAt: experiment.createdAt.toISOString(),
    finishedAt: experiment.finishedAt?.toISOString() ?? null,
  };
}

/** The suite in the wire shape: no hash, and a delta or the reason why there is none. */
function suiteFields({ baselineId, verdict, rows }: SuiteTable) {
  return {
    baselineId,
    verdict,
    evals: rows.map(({ delta, scorers, ...row }) => ({
      evalId: row.evalId,
      name: row.name,
      version: row.number,
      cases: row.cases,
      counts: row.counts,
      score: row.score,
      scorers: scorers.map(({ hash: _, ...scorer }) => scorer),
      delta: delta?.ok ? { score: delta.score, scorers: delta.scorers } : null,
      deltaRefusal: delta && !delta.ok ? { reason: delta.reason, message: delta.message } : null,
    })),
  };
}

/** In the frozen order. */
export function caseCounts(
  experiment: Pick<Experiment, "caseVersions">,
  trials: readonly Pick<Trial, "caseVersionId" | "result">[],
): CaseCounts[] {
  const byCase = trialsByCase(trials);
  return experiment.caseVersions.map((frozen) => ({
    ...frozen,
    counts: countTrials(byCase.get(frozen.versionId) ?? []),
  }));
}

export function trialsByCase<T extends Pick<Trial, "caseVersionId">>(
  trials: readonly T[],
): Map<string, T[]> {
  return Map.groupBy(trials, ({ caseVersionId }) => caseVersionId);
}
