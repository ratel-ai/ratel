export function evalsHref(projectId: string): string {
  return `/project/${projectId}/evals`;
}

export function caseHref(projectId: string, caseId: string): string {
  return `${evalsHref(projectId)}/cases/${caseId}`;
}
