/**
 * Dates for the settings and organization pages. A fixed locale and UTC, so
 * the server render and the browser agree and a key's expiry reads the same
 * day it was set for.
 */

const DAY = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

const LONG_DAY = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});

const STAMP = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** "Oct 15, 2026". */
export function formatDay(value: Date | string): string {
  return DAY.format(toDate(value));
}

/** "October 15, 2026", for sentences. */
export function formatLongDay(value: Date | string): string {
  return LONG_DAY.format(toDate(value));
}

/** "Oct 15, 2026, 09:41:07 UTC": the absolute time behind a relative one. */
export function formatStamp(value: Date | string): string {
  return `${STAMP.format(toDate(value))} UTC`;
}

/**
 * "just now", "3m ago", "5h ago", "12d ago": the same words Overview uses for
 * its runs, kept here so client views do not pull the intent-graph module.
 */
export function relativeTime(value: Date | string, now: Date): string {
  const seconds = Math.max(0, Math.round((now.getTime() - toDate(value).getTime()) / 1_000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 60) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 24) return `${months}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}

/** A non-breaking space: a number never wraps away from its unit. */
export const NBSP = " ";

/** Whole bytes below a kilobyte, one decimal above ("320 B", "1.5 KB"). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}${NBSP}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}${NBSP}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}${NBSP}MB`;
}

/** "12 ms" below a second, "1.4 s" above. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}${NBSP}ms`;
  return `${(ms / 1000).toFixed(1)}${NBSP}s`;
}
