/**
 * How fresh a project's analysis is, in one line for the sidebar (RC-39).
 *
 * Analysis runs in the background and may be a few minutes behind the data
 * (docs/design/background-worker.md, "answer now, analyze within minutes").
 * This line says so plainly, so a short delay reads as normal, not broken.
 */
export interface AnalysisFreshness {
  /** When the project's most recent analysis job finished, or null if none has. */
  updatedAt: string | null;
  /** Whether analysis jobs are queued or running for the project right now. */
  working: boolean;
  /** An import in progress: how many runs it has stored so far. */
  importing: { runsImported: number } | null;
}

/** Where one page's analysis stands (RC-210). */
export interface SectionProgress {
  /** When the newest job behind this page finished, or null if none has. */
  lastDoneAt: string | null;
  /** Jobs behind this page that are queued or running now. */
  pending: number;
}

/** Whether a page with nothing to show yet should say it is being worked out. */
export function analysisPending(progress: SectionProgress | null | undefined): boolean {
  return (progress?.pending ?? 0) > 0;
}

/** While work is pending: 5 s, then half as long again each time, 30 s at most. */
export function pendingPollMs(n: number): number {
  return Math.min(30_000, Math.round(5_000 * 1.5 ** Math.max(0, n)));
}

/** While idle: often enough to notice new work, rare enough to cost nothing. */
export const IDLE_POLL_MS = 60_000;

/**
 * Whether the page should read itself again: its work just finished, or a
 * newer result landed between two polls.
 */
export function shouldRefresh(before: SectionProgress | null, after: SectionProgress): boolean {
  if (!before) return false;
  if (before.pending > 0 && after.pending === 0) return true;
  return after.lastDoneAt !== null && after.lastDoneAt !== before.lastDoneAt;
}

export interface FreshnessLine {
  text: string;
  /** `working` while anything is in progress; the dot pulses. */
  state: "idle" | "working";
  /** The exact time, for the tooltip. */
  title: string | null;
}

const n = (value: number) => value.toLocaleString("en-US");

export function minutesAgo(at: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(at)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

export function describeFreshness(freshness: AnalysisFreshness, now: number): FreshnessLine | null {
  const title = freshness.updatedAt ? new Date(freshness.updatedAt).toLocaleString("en-GB") : null;
  if (freshness.importing) {
    const runs = freshness.importing.runsImported;
    return {
      text: runs > 0 ? `Importing history: ${n(runs)} runs` : "Importing your history",
      state: "working",
      title,
    };
  }
  if (freshness.working) {
    return {
      text: freshness.updatedAt
        ? `Updating, last ${minutesAgo(freshness.updatedAt, now)}`
        : "Analyzing your data",
      state: "working",
      title,
    };
  }
  if (!freshness.updatedAt) return null;
  return { text: `Analysis updated ${minutesAgo(freshness.updatedAt, now)}`, state: "idle", title };
}
