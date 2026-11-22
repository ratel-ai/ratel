/**
 * A rate in USD per 1M tokens: two decimals at least, more when the rate has
 * them ("$2.50", "$0.075"). A missing cache rate bills at the input rate.
 */
export function formatRate(usd: number | undefined): string {
  if (usd === undefined) return "Same as input";
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
}
