/** Share-link URLs. Kept apart from `token.ts` so client code can import them without `node:crypto`. */

/** The public page for a token, relative to the app's origin. */
export function sharePath(token: string): string {
  return `/share/health/${token}`;
}

/** The printable report for a token; `print` opens the print dialog on load. */
export function shareReportPath(token: string, print = true): string {
  return `${sharePath(token)}/report${print ? "?print=1" : ""}`;
}

/** The member's printable report for a project and window; `print` opens the print dialog on load. */
export function healthReportHref(projectId: string, days: number, print = true): string {
  return `/report/health/${encodeURIComponent(projectId)}?days=${days}${print ? "&print=1" : ""}`;
}
