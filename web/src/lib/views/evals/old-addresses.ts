import { z } from "zod";
import type { EvalCase } from "./domain/case";
import type { Experiment } from "./domain/experiment";
import { datasetHref, datasetsHref, evalsHref, runHref, trialHref } from "./paths";

/**
 * Where the old addresses of the evals pages lead (decision `runs-per-eval`): a run of the suite
 * page now lives in its eval, a case is a row of its dataset, and "New eval" is a dialog of the
 * Evals page. Only a member of the project is led on; anyone else gets nothing.
 */
export type OldAddress =
  | { kind: "new_eval" }
  | { kind: "run"; experimentId: string; trialId?: string }
  | { kind: "case"; caseId: string };

export type OldAddressDeps = {
  /** Whether the signed-in person is a member of the project. */
  isMember(projectId: string): Promise<boolean>;
  experiment(projectId: string, experimentId: string): Promise<Experiment | null>;
  evalCase(projectId: string, caseId: string): Promise<EvalCase | null>;
};

/** The new path, or null: not a member, or no such run or case in the project. */
export async function newAddress(
  projectId: string,
  old: OldAddress,
  deps: OldAddressDeps,
): Promise<string | null> {
  if (!(await deps.isMember(projectId))) return null;
  switch (old.kind) {
    case "new_eval":
      return `${evalsHref(projectId)}?new=1`;
    case "case": {
      if (old.caseId === "new") return datasetsHref(projectId);
      if (!isId(old.caseId)) return null;
      const found = await deps.evalCase(projectId, old.caseId);
      return found ? datasetHref(projectId, found.datasetId) : null;
    }
    case "run": {
      if (!isId(old.experimentId) || (old.trialId !== undefined && !isId(old.trialId))) return null;
      const experiment = await deps.experiment(projectId, old.experimentId);
      if (!experiment) return null;
      // A suite run from before has many evals: it opens in the first one.
      const evalId = experiment.evalId ?? experiment.evalVersions[0]?.evalId ?? null;
      if (evalId === null) return evalsHref(projectId);
      return old.trialId
        ? trialHref(projectId, evalId, experiment.id, old.trialId)
        : runHref(projectId, evalId, experiment.id);
    }
  }
}

function isId(value: string): boolean {
  return z.uuid().safeParse(value).success;
}
