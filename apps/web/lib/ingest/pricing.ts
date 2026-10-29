/**
 * Model → token price table. The ADR-0013 event no longer carries `cost_usd`, so
 * the ingest endpoint computes it from `usage` (see `costFor`). Rates are USD per
 * **million** tokens; `costFor` converts to an absolute dollar figure.
 *
 * `cachedInput` is the discounted rate for prompt tokens served from the
 * provider's cache (`usage.cached_tokens`) — Anthropic cache-reads bill at ~10%
 * of input, OpenAI cached input at ~50%. `cacheWrite` is the rate for prompt
 * tokens written to the cache (`usage.cache_write_tokens`; Anthropic 5-minute
 * writes bill at 1.25x input). `longContext` holds a model's higher rates for a
 * request whose prompt is over a threshold (Claude Haiku 5.5: over 100k tokens).
 * Unknown models return `null` (the dashboard's Cost metric simply omits them)
 * rather than guessing a price.
 */

export type ModelPrice = {
  /** USD per 1M input (prompt) tokens. */
  input: number;
  /** USD per 1M output (completion) tokens. */
  output: number;
  /** USD per 1M cached input tokens. Defaults to `input` when a model has no cache discount. */
  cachedInput?: number;
  /** USD per 1M tokens written to the prompt cache. Defaults to `input`. */
  cacheWrite?: number;
  /**
   * Rates for a request whose prompt (all input tokens, cache reads and writes
   * included) is over `threshold` tokens. The whole request pays these rates.
   */
  longContext?: { threshold: number } & Omit<ModelPrice, "longContext">;
};

/**
 * Keyed by model id. Lookup is exact first, then longest-prefix (so
 * `gpt-5.5-2026-01` falls back to `gpt-5.5`). Add models here as they appear.
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  // Anthropic — cache reads at ~1/10 of input.
  "claude-opus-4-8": { input: 5, output: 25, cachedInput: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-4-6": { input: 3, output: 15, cachedInput: 0.3 },
  "claude-sonnet-4-5": { input: 3, output: 15, cachedInput: 0.3 },
  "claude-haiku-4-5": { input: 1, output: 5, cachedInput: 0.1 },
  // https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-10-22).
  // Priced by prompt length; cacheWrite is the 5-minute write rate.
  "claude-haiku-5-5": {
    input: 0.1,
    output: 0.5,
    cachedInput: 0.01,
    cacheWrite: 0.125,
    longContext: {
      threshold: 100_000,
      input: 0.5,
      output: 2.5,
      cachedInput: 0.05,
      cacheWrite: 0.625,
    },
  },
  // OpenAI — cached input at ~1/2.
  "gpt-5.5": { input: 2.5, output: 10, cachedInput: 1.25 },
  "gpt-5": { input: 2.5, output: 10, cachedInput: 1.25 },
  "gpt-5-mini": { input: 0.6, output: 2.4, cachedInput: 0.3 },
};

/** Resolve a model id to its price, exact match then longest matching prefix. */
export function priceFor(model: string | null | undefined): ModelPrice | null {
  if (!model) return null;
  if (MODEL_PRICES[model]) return MODEL_PRICES[model];
  let best: { key: string; price: ModelPrice } | null = null;
  for (const [key, price] of Object.entries(MODEL_PRICES)) {
    if (model.startsWith(key) && (!best || key.length > best.key.length)) {
      best = { key, price };
    }
  }
  return best?.price ?? null;
}

/** Token usage relevant to cost — a subset of the event's `usage`. */
export type CostUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cached_tokens?: number | null;
  /** Prompt tokens written to the cache (`gen_ai.usage.cache_creation.input_tokens`). */
  cache_write_tokens?: number | null;
};

/**
 * Absolute USD cost of a call, or `null` when the model is unpriced. Cached
 * reads and cache writes are billed at their own rates and the remaining input
 * at full rate; `cached_tokens` and `cache_write_tokens` are treated as subsets
 * of `input_tokens` (OTel semconv: input counts every prompt token). A model with
 * `longContext` rates bills the whole call at them when `input_tokens` is over
 * the threshold.
 */
export function costFor(
  model: string | null | undefined,
  usage: CostUsage | null | undefined,
): number | null {
  const base = priceFor(model);
  if (!base || !usage) return null;
  const input = Math.max(0, usage.input_tokens ?? 0);
  const output = Math.max(0, usage.output_tokens ?? 0);
  const cached = Math.min(Math.max(0, usage.cached_tokens ?? 0), input);
  const written = Math.min(Math.max(0, usage.cache_write_tokens ?? 0), input - cached);
  const price = base.longContext && input > base.longContext.threshold ? base.longContext : base;
  const cachedRate = price.cachedInput ?? price.input;
  const writeRate = price.cacheWrite ?? price.input;
  const usd =
    ((input - cached - written) * price.input +
      cached * cachedRate +
      written * writeRate +
      output * price.output) /
    1_000_000;
  // Round to the `numeric(12,6)` storage precision so it round-trips cleanly.
  return Math.round(usd * 1_000_000) / 1_000_000;
}
