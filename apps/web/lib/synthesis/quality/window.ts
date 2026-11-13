import type { ExperimentWindow } from "@/lib/synthesis/experiments/service";

/**
 * The window every quality surface reads.
 *
 * Defaults to 14 days: long enough that a partner's week of traffic is not one
 * quiet afternoon, short enough that a searchable-description edit made last
 * Tuesday is still visible as a change rather than averaged into a month.
 *
 * Capped at 90 because `otel_logs` is pruned at 30 days. Beyond that the live
 * read has nothing and only the stored daily rollup can answer, which the trend
 * chart uses and the headline deliberately does not.
 */
export const DEFAULT_QUALITY_WINDOW_DAYS = 14;
export const MAX_QUALITY_WINDOW_DAYS = 90;

export function parseWindowDays(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_QUALITY_WINDOW_DAYS;
  return Math.min(MAX_QUALITY_WINDOW_DAYS, Math.max(1, Math.floor(parsed)));
}

/** Alias kept readable at call sites that only want the number for a label. */
export function QUALITY_WINDOW_DAYS(raw: string | undefined): number {
  return parseWindowDays(raw);
}

export function resolveQualityWindow(
  raw: string | undefined,
  now: Date = new Date(),
): ExperimentWindow {
  const days = parseWindowDays(raw);
  return {
    since: new Date(now.getTime() - days * 24 * 60 * 60 * 1000),
    until: new Date(now.getTime() + 60 * 1000),
  };
}
