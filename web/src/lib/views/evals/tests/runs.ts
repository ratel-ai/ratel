import type { Compared } from "../baseline";
import type { EvalScorer } from "../domain/eval";
import type { Experiment, Trial } from "../domain/experiment";
import { snapshotOf, type TrialResult } from "../domain/score";
import { NO_REFUND, ORGANIZATION_ID, PROJECT_ID } from "./support";

/** Runs as the suite read models read them, for the tests. */
export const POLITE: EvalScorer = {
  id: "polite",
  name: "Polite",
  gating: false,
  definition: { kind: "judge", config: { prompt: "polite?", output: "boolean" } },
};
export const T0 = new Date("2026-11-26T10:00:00Z");

export type Spec = Record<string, { scorers?: EvalScorer[]; cases: Record<string, TrialResult[]> }>;

/** A completed run. Each trial passes or fails every scorer with its result. */
export function run(id: string, spec: Spec): Compared {
  const experiment: Experiment = {
    id,
    projectId: PROJECT_ID,
    organizationId: ORGANIZATION_ID,
    evalId: null,
    datasetId: null,
    variants: [],
    changes: {},
    sandboxVersionId: "sv",
    sandboxName: "support-demo",
    name: null,
    labelFilter: null,
    gitCommit: "",
    gitDirty: false,
    params: {},
    trialsPerCase: 3,
    caseVersions: [],
    evalVersions: [],
    scorerSnapshots: {},
    startedBy: "u",
    state: "completed",
    createdAt: T0,
    finishedAt: T0,
  };
  const trials: Trial[] = [];
  for (const [evalId, { scorers = [NO_REFUND], cases }] of Object.entries(spec)) {
    experiment.evalVersions.push({
      evalId,
      versionId: `${evalId}-v1`,
      number: 1,
      name: evalId,
      params: {},
      trials: 3,
    });
    for (const [caseId, results] of Object.entries(cases)) {
      const versionId = `${id}-${caseId}`;
      experiment.caseVersions.push({ caseId, versionId, number: 1, name: caseId, evalId });
      experiment.scorerSnapshots[versionId] = scorers.map(snapshotOf);
      results.forEach((result, index) => {
        const status = result === "invalid" ? "not_scored" : result;
        trials.push({
          id: `${versionId}-t${index}`,
          experimentId: id,
          caseVersionId: versionId,
          variant: 0,
          index,
          state: "done",
          result,
          reason: null,
          scorers: scorers.map(({ id: scorerId, name, gating, definition }) => ({
            scorerId,
            name,
            kind: definition.kind,
            gating,
            status,
            reason: "",
          })),
          costUsd: null,
          durationMs: null,
          traceId: `${id}-trace-${index}`,
          sandboxRunId: null,
        });
      });
    }
  }
  return { experiment, trials };
}
