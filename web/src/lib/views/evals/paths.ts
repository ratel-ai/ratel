export function evalsHref(projectId: string): string {
  return `/project/${projectId}/evals`;
}

export function caseHref(projectId: string, caseId: string): string {
  return `${evalsHref(projectId)}/cases/${caseId}`;
}

export function experimentHref(projectId: string, experimentId: string): string {
  return `${evalsHref(projectId)}/experiments/${experimentId}`;
}

export function compareHref(projectId: string, experimentId: string): string {
  return `${experimentHref(projectId, experimentId)}/compare`;
}

/** The suite table of a run. With no run, the newest one. */
export function suiteHref(projectId: string, runId: string | null = null): string {
  return runId ? `${evalsHref(projectId)}?run=${runId}` : evalsHref(projectId);
}

export function evalHref(projectId: string, evalId: string, runId: string | null = null): string {
  const path = `${evalsHref(projectId)}/${evalId}`;
  return runId ? `${path}?run=${runId}` : path;
}

export function newEvalHref(projectId: string): string {
  return `${evalsHref(projectId)}/new`;
}

/** One trial of a run, next to the baseline trial of the same row. */
export function trialHref(projectId: string, runId: string, trialId: string): string {
  return `${experimentHref(projectId, runId)}/trials/${trialId}`;
}

export function datasetsHref(projectId: string): string {
  return `/project/${projectId}/datasets`;
}

export function datasetHref(projectId: string, datasetId: string): string {
  return `${datasetsHref(projectId)}/${datasetId}`;
}

/** The trace turn that a row was saved from. */
export function turnHref(projectId: string, turnId: string): string {
  return `/project/${projectId}/traces/turns/${turnId}`;
}
