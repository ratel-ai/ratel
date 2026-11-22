/**
 * Shared numeric display formatters used by both the dashboard KPIs
 * (`lib/dashboard.ts`) and the trace explorer (`lib/traces/format.ts`), kept in
 * a leaf module so the same value never renders differently across surfaces.
 */

/** Whole count with thousands separators (e.g. 1,284) — for run counts. */
export function fmtCount(v: number): string {
  return Math.round(v).toLocaleString("en-US");
}

/**
 * Dollar amount, two decimals at a cent or more. Sub-cent costs keep enough
 * precision (~2 significant digits) that they don't collapse to "$0.00".
 */
export function fmtCost(v: number): string {
  const abs = Math.abs(v);
  if (abs === 0 || abs >= 0.01) return `$${v.toFixed(2)}`;
  const decimals = Math.min(8, Math.max(3, Math.ceil(-Math.log10(abs)) + 1));
  return `$${v.toFixed(decimals)}`;
}
