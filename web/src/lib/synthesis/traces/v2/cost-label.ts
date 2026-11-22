import { formatMoney } from "./format";

/**
 * RC-482: a model call whose model has no price stores no cost. Summed, it
 * would read "$0.00", which says the call was free. These read "Unpriced"
 * instead; Settings > General > Model pricing is where a price is set.
 */

export interface CostFields {
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: string | number | null;
}

/** A model call that reported tokens and has no cost: its model has no price. */
export function isUnpricedCall(span: CostFields): boolean {
  return (
    span.costUsd === null &&
    span.model !== null &&
    (span.inputTokens !== null || span.outputTokens !== null)
  );
}

/** A cost with the number of its model calls that have no price. */
export function costLabel(
  costUsd: number | string | null | undefined,
  unpricedCalls: number,
): string {
  if (unpricedCalls <= 0) return formatMoney(costUsd);
  const value = typeof costUsd === "string" ? Number(costUsd) : (costUsd ?? 0);
  if (!value) return "Unpriced";
  return `${formatMoney(value)} + unpriced`;
}
