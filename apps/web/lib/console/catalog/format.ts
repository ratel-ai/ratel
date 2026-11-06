/**
 * Numbers and times for the Catalog (DESIGN.md, Numbers and Time): stats
 * abbreviate, tables stay exact, money has two decimals, lists say how long
 * ago and details say when. Times are UTC and relative ones take the server's
 * "now", so the server render and hydration agree.
 */

const NBSP = " ";

const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const EXACT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const MONEY = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** "45", "1.3K", "12.4K", "2.1M". */
export function fmtCompact(value: number): string {
  return Number.isFinite(value) ? COMPACT.format(value) : "0";
}

/** "1,284". */
export function fmtExact(value: number): string {
  return Number.isFinite(value) ? EXACT.format(value) : "0";
}

/** "$0.00", "<$0.01", "$1,204.50". Two decimals always, never a fraction of a cent. */
export function fmtMoney(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "$0.00";
  if (Math.abs(value) < 0.01) return "<$0.01";
  return `$${MONEY.format(value)}`;
}

const DAY = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
// `hourCycle`, not `hour12: false`: older engines resolve the latter to h24 and print midnight as 24:00.
const TIME = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

/** "Oct 9, 2026". */
export function fmtDay(iso: string): string {
  return DAY.format(new Date(iso));
}

/** "Oct 9, 2026, 12:23 UTC", for tooltips and details. */
export function fmtDateTime(iso: string): string {
  const date = new Date(iso);
  return `${DAY.format(date)}, ${TIME.format(date)}${NBSP}UTC`;
}

/** "just now", "5 min ago", "3 h ago", "6 days ago", then the day itself past a month. */
export function fmtRelative(iso: string, nowIso: string): string {
  const seconds = Math.max(0, (new Date(nowIso).getTime() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}${NBSP}min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}${NBSP}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 31) return days === 1 ? "yesterday" : `${days}${NBSP}days ago`;
  return fmtDay(iso);
}

/** "1 tool", "97 tools". */
export function plural(count: number, one: string, many: string = `${one}s`): string {
  return `${fmtExact(count)} ${count === 1 ? one : many}`;
}
