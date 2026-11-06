/**
 * The formatters the printed report and its panels share, as upstream's admin console has
 * them (locale-stable, en-IE). Owned (ADR-0030): the admin console is excluded as a folder, so
 * the three the report uses are kept here.
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
