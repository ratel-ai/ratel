import type { ModelUsage } from "@/lib/contracts/models";
import { costFor, type ModelPrice, ratelBudgetCostFor } from "@/lib/ingest/pricing";
import { configured } from "@/lib/platform/env-configured";
import { getLogger } from "@/lib/platform/logger";
import type { Env } from "./config";

/**
 * What one of Ratel's own model calls counts against a budget (ADR-0033 §8). `MODEL_PRICES` is
 * read first: JSON of model id to `{ input, output, cachedInput? }` in dollars per million
 * tokens, where 0 is a price (a local model). Then Ratel's own rates. A model neither prices
 * is charged at the fallback rate, so an unknown hosted model can never run past a cap.
 */

/** Priced at this model's rate when a model has no price. The eval gate uses the same one. */
export const FALLBACK_PRICE_MODEL = "claude-opus-4-8";

const logger = getLogger("models/prices");
let warnedUnreadable = false;

function isRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** The deployment's own prices from `MODEL_PRICES`; empty when unset or unreadable. */
export function priceOverrides(env: Env = process.env): Record<string, ModelPrice> {
  const raw = configured(env.MODEL_PRICES);
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
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
export function budgetCostFor(model: string, usage: ModelUsage, env: Env = process.env): number {
  const cost = {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cached_tokens: usage.cachedTokens,
  };
  const overrides = priceOverrides(env);
  if (overrides[model]) return costFor(model, cost, { overrides }) ?? 0;
  return (
    ratelBudgetCostFor(model, cost) ??
    ratelBudgetCostFor(FALLBACK_PRICE_MODEL, {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
    }) ??
    0
  );
}
