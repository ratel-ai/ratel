import {
  type Counts,
  countTrials,
  type Experiment,
  type FrozenCase,
  type Trial,
} from "./domain/experiment";

/** One case of an experiment with its raw counts. */
export type CaseCounts = FrozenCase & { counts: Counts };

/**
 * The wire shape (`protocol/evals/v1/experiment.schema.json`). It has no captured text: no output,
 * no tool call and no scorer reason. The experiment page shows them to a member.
 */
export function experimentView(experiment: Experiment, trials: readonly Trial[], url: string) {
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
      trials: trials
        .filter(({ caseVersionId }) => caseVersionId === frozen.versionId)
        .map((trial) => ({
          trialId: trial.id,
          index: trial.index,
          result: trial.result,
          reason: trial.result === "invalid" ? trial.reason : null,
          traceId: trial.traceId,
          sandboxRunId: trial.sandboxRunId,
          scorers: trial.scorers.map(({ name, gating, status }) => ({ name, gating, status })),
        })),
    })),
    createdAt: experiment.createdAt.toISOString(),
    finishedAt: experiment.finishedAt?.toISOString() ?? null,
  };
}

/** In the frozen order. */
export function caseCounts(
  experiment: Pick<Experiment, "caseVersions">,
  trials: readonly Pick<Trial, "caseVersionId" | "result">[],
): CaseCounts[] {
  const byCase = Map.groupBy(trials, ({ caseVersionId }) => caseVersionId);
  return experiment.caseVersions.map((frozen) => ({
    ...frozen,
    counts: countTrials(byCase.get(frozen.versionId) ?? []),
  }));
}
