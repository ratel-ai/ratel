/**
 * The addresses of the Evals and Datasets pages (decision `runs-per-eval`): the evals with their
 * chart, one eval with its runs, one run with its rows, one trial next to the baseline trial, and
 * the datasets with their rows.
 */

export function evalsHref(projectId: string): string {
  return `/project/${projectId}/evals`;
}

export function evalHref(projectId: string, evalId: string): string {
  return `${evalsHref(projectId)}/${evalId}`;
}

/** One run of one eval. A suite run from before has no eval: it has no page of its own. */
export function runHref(projectId: string, evalId: string, runId: string): string {
  return `${evalHref(projectId, evalId)}/runs/${runId}`;
}

/** One trial of a run, next to the baseline trial of the same row. */
export function trialHref(
  projectId: string,
  evalId: string,
  runId: string,
  trialId: string,
): string {
  return `${runHref(projectId, evalId, runId)}/trials/${trialId}`;
}

export function datasetsHref(projectId: string): string {
  return `/project/${projectId}/datasets`;
}

export function datasetHref(projectId: string, datasetId: string): string {
  return `${datasetsHref(projectId)}/${datasetId}`;
}

/** The trace page of the turn that a row was saved from. */
export function turnHref(projectId: string, turnId: string): string {
  return `/project/${projectId}/traces/turns/${turnId}`;
}

/** The old address of a run (before runs belonged to one eval). It redirects. */
export function experimentHref(projectId: string, experimentId: string): string {
  return `${evalsHref(projectId)}/experiments/${experimentId}`;
}
