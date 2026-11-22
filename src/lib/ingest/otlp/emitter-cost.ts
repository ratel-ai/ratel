import { attrNumber } from "./anyvalue";
import type { AttrMap } from "./types";

/**
 * The cost an emitter put on its own model call (AOBS-3), in USD. Ratel
 * prices a call from its price book; this is the fallback for a call the book
 * has no price for (a harness that bills by its own rates).
 *
 * Keys, in priority order: Ratel's own `ratel.usage.cost_usd`, then
 * `gen_ai.usage.cost`, which OpenRouter, LiteLLM and Langfuse emitters send.
 * Both are content-free keys that `otel_spans.attributes` keeps, so a stored
 * span can be re-priced with the same fallback.
 */
export const EMITTER_COST_KEYS = ["ratel.usage.cost_usd", "gen_ai.usage.cost"] as const;

/** Below the `numeric(12,6)` a cost is stored as. */
const MAX_COST_USD = 1_000_000;

/** The first plausible emitter cost on these attributes, else null. */
export function emitterCostUsd(attributes: AttrMap): number | null {
  for (const key of EMITTER_COST_KEYS) {
    const cost = plausibleCostUsd(attrNumber(attributes, key));
    if (cost !== null) return cost;
  }
  return null;
}

/** A finite, non-negative amount under the stored bound, at the stored precision; else null. */
export function plausibleCostUsd(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value < 0 || value >= MAX_COST_USD) return null;
  return Math.round(value * 1_000_000) / 1_000_000;
}
