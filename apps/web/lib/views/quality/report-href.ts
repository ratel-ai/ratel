/**
 * The printable Quality report for one calibration and window:
 * `/report/quality/<project>?calibration=<name>&days=<n>`. Upstream links it only from its
 * admin console; here the calibration detail offers it to the member (ADR-0030).
 */
export function qualityReportHref(projectId: string, experimentName: string, days: number): string {
  return `/report/quality/${encodeURIComponent(projectId)}?calibration=${encodeURIComponent(experimentName)}&days=${days}`;
}

const DAY_MS = 86_400_000;

/** A page's range as the whole days the report takes; a window shorter than a day is one day. */
export function reportWindowDays(window: { since: Date; until: Date }): number {
  return Math.max(1, Math.round((window.until.getTime() - window.since.getTime()) / DAY_MS));
}
