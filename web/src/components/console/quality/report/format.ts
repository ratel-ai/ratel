/**
 * The formatters the printed report, its panels and the operator Quality pages share, as
 * upstream's admin console has them (locale-stable, en-IE). Owned (ADR-0004): the admin console
 * is excluded as a folder, so the four they use are kept here.
 */

const INT = new Intl.NumberFormat("en-IE");
const COMPACT = new Intl.NumberFormat("en-IE", { notation: "compact", maximumFractionDigits: 1 });

export function fmtInt(n: number): string {
  return INT.format(Math.round(n));
}

/** Compact large counts: 12_400 → "12.4K". */
export function fmtCompact(n: number): string {
  return COMPACT.format(n);
}

export function fmtPct(fraction: number, dp = 0): string {
  return `${(fraction * 100).toFixed(dp)}%`;
}

/** Relative "3d ago" / "just now" for activity columns. */
export function fmtAgo(d: Date | string | null | undefined): string {
  if (!d) return "never";
  const date = typeof d === "string" ? new Date(d) : d;
  const secs = Math.max(0, (Date.now() - date.getTime()) / 1000);
  if (secs < 60) return "just now";
  const mins = secs / 60;
  if (mins < 60) return `${Math.floor(mins)}m ago`;
  const hours = mins / 60;
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  const days = hours / 24;
  if (days < 30) return `${Math.floor(days)}d ago`;
  const months = days / 30;
  if (months < 12) return `${Math.floor(months)}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}
