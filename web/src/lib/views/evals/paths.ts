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
