import { type Config, getConfig } from "@/config";
import type { ModelUsage } from "@/lib/contracts/models";
import { costFor, type ModelPrice, ratelBudgetCostFor } from "@/lib/ingest/pricing";
import { getLogger } from "@/lib/platform/logger";
import { isClaudeModel } from "./vendors";

/**
 * What one of Ratel's own model calls counts against a budget (ADR-0009 §8). `MODEL_PRICES` is
 * read first: JSON of model id to `{ input, output, cachedInput? }` in dollars per million
 * tokens, where 0 is a price (a local model). Then the vendors' list prices, and Ratel's own rates
 * for Claude. A model none of them prices is charged at the fallback rate, so an unknown hosted model can never run past a cap.
 */

/** Priced at this model's rate when a model has no price. The eval gate uses the same one. */
export const FALLBACK_PRICE_MODEL = "claude-opus-4-8";

/**
 * List prices of the vendors' default models that the customer price table does not have, in
 * dollars per million tokens, from each vendor's pricing page (checked 2026-11-23).
 */
const VENDOR_PRICES: Readonly<Record<string, ModelPrice>> = {
  "gpt-6.2-astra": { input: 8, output: 40, cachedInput: 0.4 },
  "gpt-6.2-sol": { input: 2, output: 10, cachedInput: 0.1 },
  "gpt-6-luna": { input: 0.1, output: 0.5, cachedInput: 0.01 },
};

const logger = getLogger("models/prices");
let warnedUnreadable = false;

function isRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** The deployment's own prices from `MODEL_PRICES`; empty when unset or unreadable. */
export function priceOverrides(
  config: Pick<Config, "modelVendor"> = getConfig(),
): Record<string, ModelPrice> {
  const raw = config.modelVendor.prices;
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    parsed = null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    if (!warnedUnreadable) {
      warnedUnreadable = true;
      logger.warn({}, "MODEL_PRICES is not a JSON object of model id to price; ignored");
    }
    return {};
  }
  const out: Record<string, ModelPrice> = {};
  for (const [model, value] of Object.entries(parsed)) {
    if (value === null || typeof value !== "object") continue;
    const { input, output, cachedInput } = value as Record<string, unknown>;
    if (!isRate(input) || !isRate(output)) continue;
    out[model] = isRate(cachedInput) ? { input, output, cachedInput } : { input, output };
  }
  return out;
}

/** Dollars this call counts against a budget. Never null: an unpriced model has the fallback rate. */
export function budgetCostFor(
  model: string,
  usage: ModelUsage,
  config: Pick<Config, "modelVendor"> = getConfig(),
): number {
  const cost = {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cached_tokens: usage.cachedTokens,
  };
  const overrides = priceOverrides(config);
  if (overrides[model]) return costFor(model, cost, { overrides }) ?? 0;
  const vendorPrice = VENDOR_PRICES[model];
  if (vendorPrice) return costFor(model, cost, { overrides: { [model]: vendorPrice } }) ?? 0;
  // Ratel's own rates match by prefix, which is right for a Claude snapshot and wrong for a
  // newer model of another vendor; those are priced by the customer table, by exact name.
  const known = isClaudeModel(model) ? ratelBudgetCostFor(model, cost) : costFor(model, cost);
  return (
    known ??
    ratelBudgetCostFor(FALLBACK_PRICE_MODEL, {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
    }) ??
    0
  );
}
