/**
 * The two number formats every page shares, on the product's rules (DESIGN.md,
 * Numbers): whole percents and counts with grouping. On their own, with no
 * imports, so anything that only prints a number (an MCP Apps view) can use
 * the console's formatter without loading the claim templates in `claims.ts`,
 * which re-exports both.
 *
 * Pure: no React, no I/O, no locale reads beyond `en-US` number grouping.
 */

/** A share in [0, 1] as a whole percent. A real but tiny share reads "<1%", never "0%". */
export function formatSharePercent(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return "0%";
  if (share >= 1) return "100%";
  const whole = Math.round(share * 100);
  if (whole === 0) return "<1%";
  // 99.6% is not everything; say so rather than print a 100 that is not true.
  if (whole === 100) return ">99%";
  return `${whole}%`;
}

/** A count with thousands grouping: `7,190`. */
export function formatCount(count: number): string {
  return Math.round(count).toLocaleString("en-US");
}
