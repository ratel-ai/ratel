/** One scorer's page: its results over time. No page lists scorers. */
export function scorerHref(projectId: string, scorerId: string): string {
  return `/project/${encodeURIComponent(projectId)}/scorers/${encodeURIComponent(scorerId)}`;
}

export function traceHref(projectId: string, traceId: string): string {
  return `/project/${encodeURIComponent(projectId)}/traces/${encodeURIComponent(traceId)}`;
}
