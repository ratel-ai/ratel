/**
 * When the run Panel reads a run again (pure, so the rules are tested).
 *
 * A summary is kept per run and per span count the list showed, so a list that
 * reloads with more spans reads the run again. A run that has not finished,
 * and a read that failed, go stale after a few seconds: reopening one shows
 * its latest spans instead of a partial run frozen for the page's life.
 */

import type { RunSummaryResult } from "./run-summary-route";

/** How long an unfinished run or a failed read is shown before it is read again. */
export const SUMMARY_FRESH_MS = 15_000;
/** Moving with `j` and `k` waits this long before reading, so the runs passed on the way are never read. */
export const SUMMARY_READ_DELAY_MS = 150;

export interface SummaryEntry {
  result: RunSummaryResult;
  /** When the read finished, epoch ms. */
  at: number;
}

export function summaryKey(id: string, spanCount: number | null | undefined): string {
  return spanCount === null || spanCount === undefined ? id : `${id}:${spanCount}`;
}

export function isFreshSummary(entry: SummaryEntry, nowMs: number): boolean {
  if (entry.result.ok && entry.result.summary.status !== "incomplete") return true;
  return nowMs - entry.at < SUMMARY_FRESH_MS;
}
