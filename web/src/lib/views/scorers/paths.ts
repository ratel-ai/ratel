export function scorersHref(projectId: string): string {
  return `/project/${encodeURIComponent(projectId)}/scorers`;
}

export function traceHref(projectId: string, traceId: string): string {
  return `/project/${encodeURIComponent(projectId)}/traces/${encodeURIComponent(traceId)}`;
}
