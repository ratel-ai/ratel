import type { ExperimentWindow } from "@/lib/synthesis/experiments/service";
import { MAX_QUALITY_WINDOW_DAYS } from "@/lib/synthesis/quality/window";

/**
 * The window a run reads.
 *
 * Deliberately NOT `lib/quality/window.ts`'s default. That surface is a live
 * meter and defaults to 14 days so a recent edit stays visible; this one is a
 * weekly job, so its natural period is the week since the last one.
 *
 * The hard ceiling is the same, and for the same reason: `otel_logs` is pruned at
 * 30 days, so asking for more returns a window that is mostly empty while
 * claiming to be long. `MAX_QUALITY_WINDOW_DAYS` (90) exists on the meter to make
 * the retention wall visible next to a stored rollup; a run has no rollup to fall
 * back on, so it clamps to the retention wall itself.
 */
export const DEFAULT_RUN_WINDOW_DAYS = 7;

/** Beyond this the telemetry is gone, so a longer request is a longer lie. */
export const MAX_RUN_WINDOW_DAYS = 30;

/** The windows the surface offers, matching the quality meter's control. */
export const RUN_WINDOW_OPTIONS: readonly number[] = [7, 14, 30];

const DAY_MS = 24 * 60 * 60 * 1000;

export function parseRunWindowDays(raw: string | number | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_RUN_WINDOW_DAYS;
  return Math.min(MAX_RUN_WINDOW_DAYS, Math.max(1, Math.floor(parsed)));
}

/**
 * Widen a scheduled window back to the last change that actually landed.
 *
 * This is the other half of "proposals never stack". If nobody applied last
 * week's proposals, the corpus has not moved, so scoring only the last seven days
 * would re-ask the same question with a smaller sample and no new information.
 * Reaching back to the last applied change instead means the second run is
 * strictly better evidenced than the first.
 *
 * Clamped to the retention wall, so a corpus untouched for months still reads a
 * window that exists rather than one that is 90% empty.
 */
export function windowSinceLastChange(
  lastChangeAt: Date | null,
  now: Date,
  defaultDays: number = DEFAULT_RUN_WINDOW_DAYS,
): number {
  if (lastChangeAt === null) return defaultDays;
  const elapsedDays = Math.ceil((now.getTime() - lastChangeAt.getTime()) / DAY_MS);
  if (!Number.isFinite(elapsedDays)) return defaultDays;
  return Math.min(MAX_RUN_WINDOW_DAYS, Math.max(defaultDays, elapsedDays));
}

/** Resolve a day count into the `{ since, until }` every quality query takes. */
export function resolveRunWindow(days: number, now: Date = new Date()): ExperimentWindow {
  const clamped = parseRunWindowDays(days);
  return {
    // A minute of headroom for clock skew between the app and the ingest path,
    // exactly as resolveQualityWindow does.
    until: new Date(now.getTime() + 60 * 1000),
    since: new Date(now.getTime() - clamped * DAY_MS),
  };
}

/** Guard against a caller passing the meter's 90-day option to a run. */
export function isRunWindowSupported(days: number): boolean {
  return days <= MAX_RUN_WINDOW_DAYS && days <= MAX_QUALITY_WINDOW_DAYS;
}

/**
 * The start of the current billing period, approximated as the calendar month.
 *
 * The exact anchor is `organizations.current_period_end`, but a run budget does
 * not need to agree with the billing provider to the second: being a few days out affects only
 * when a Pro account's fourth run of the month becomes available, and reading the
 * real anchor would put a the billing provider-shaped dependency inside the cron drain.
 *
 * Defined once because the sweep, the manual-run action and the page must agree.
 * Three copies of this would drift the moment one of them started reading the billing provider,
 * and the symptom would be a page that says a run is available and an action that
 * refuses it.
 */
export function startOfBillingPeriod(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * When the run budget next refills.
 *
 * Worth naming a date rather than saying "next billing period": this counter
 * genuinely resets on the first of the month, because that is the anchor above,
 * so the vaguer phrasing would be less true as well as less useful.
 */
export function nextBillingPeriodStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}
