/**
 * The printable Agent health report for one window: `/report/health/<project>?days=<n>`, opening
 * the print dialog by default. Upstream keeps this beside the public share links, which are not
 * part of this edition; the member report is.
 */
export function healthReportHref(projectId: string, days: number, print = true): string {
  return `/report/health/${encodeURIComponent(projectId)}?days=${days}${print ? "&print=1" : ""}`;
}
