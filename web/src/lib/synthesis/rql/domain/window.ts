import { fail } from "./errors";
import { RQL_LIMITS } from "./limits";

/** The time range of a query: rows whose time column is at or after `from` and before `to`. */
export interface RqlWindow {
  from: Date;
  to: Date;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The window of a query: the one the caller gives, or the last `defaultWindowHours` before
 * `now`. A window that is empty, reversed or longer than `maxWindowDays` is refused.
 */
export function resolveWindow(now: Date, window: RqlWindow | undefined): RqlWindow {
  const resolved = window ?? {
    from: new Date(now.getTime() - RQL_LIMITS.defaultWindowHours * HOUR_MS),
    to: now,
  };
  const { from, to } = resolved;
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    fail("invalid_window", "The window has a date that is not valid.", "Give ISO 8601 dates.");
  }
  if (from.getTime() >= to.getTime()) {
    fail(
      "invalid_window",
      `The window starts at ${from.toISOString()}, which is not before its end ${to.toISOString()}.`,
      "Give a window whose start is before its end.",
    );
  }
  if (to.getTime() - from.getTime() > RQL_LIMITS.maxWindowDays * DAY_MS) {
    fail(
      "invalid_window",
      `The window is longer than ${RQL_LIMITS.maxWindowDays} days.`,
      `Give a window of at most ${RQL_LIMITS.maxWindowDays} days, or run one query for each part.`,
    );
  }
  return resolved;
}
