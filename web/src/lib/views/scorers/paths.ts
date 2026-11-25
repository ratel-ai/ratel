export function scorersHref(projectId: string): string {
  return `/project/${encodeURIComponent(projectId)}/scorers`;
}

/** A new scorer, scoped to a task. */
export function newTaskScorerHref(projectId: string, taskId: string): string {
  return `${scorersHref(projectId)}/new?task=${encodeURIComponent(taskId)}`;
}

export function traceHref(projectId: string, traceId: string): string {
  return `/project/${encodeURIComponent(projectId)}/traces/${encodeURIComponent(traceId)}`;
}
