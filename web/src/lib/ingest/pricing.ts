/**
 * Model → token price table. The agent event no longer carries `cost_usd`, so
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
 *
 * Owned (ADR-0004): upstream's file also prices the vendor models Ratel itself calls (the
 * decision engines and the hosted embedding model) next to their clients, which are the
 * edition's; that section lives with them in the private edition. The rest is upstream's.
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

/** A project's own prices, keyed by model id. They win over {@link MODEL_PRICES}. */
export type PriceOverrides = Readonly<Record<string, ModelPrice>>;

/**
 * The prices of a project (RC-482): the current {@link MODEL_PRICES}, the
 * date-only lookup and the project's own overrides. No book means the current
 * table with no overrides. Ratel's own budget costs never read a book: see
 * {@link RATEL_BUDGET_PRICES}.
 */
export type PriceBook = { readonly overrides: PriceOverrides };

/**
 * Ingest could not read the project's own prices (RC-482). The batch stores
 * no cost, and `backfill:costs` prices it later with the right book.
 */
export const PRICES_UNKNOWN = "unknown" as const;

/** What ingest prices a batch with: a book (absent: the current prices), or no cost at all. */
export type BatchPrices = PriceBook | typeof PRICES_UNKNOWN | undefined;

/** The current prices with no project overrides. */
export const CURRENT_PRICES: PriceBook = Object.freeze({ overrides: Object.freeze({}) });

/** Where a resolved price came from: the project's own, or the built-in table. */
export type ResolvedPrice = { key: string; price: ModelPrice; source: "custom" | "built-in" };

/**
 * The current table (RC-482): the built-in price of every customer model
 * call (see {@link PriceBook}). Keyed by model id. Lookup
 * is exact first, then the longest key the id extends by a date (so
 * `gpt-4o-2024-08-06` falls back to `gpt-4o`, but `gpt-4o-mini` never falls
 * back to `gpt-4o`, `o3-pro` never to `o3` and `gpt-5.2` never to `gpt-5`).
 * Add models here as they appear.
 * Models with no canonical price (Llama, which every host prices on its own)
 * stay out: a project prices them with its own overrides.
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  // Anthropic: https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-11-09).
  // cacheWrite is the 5-minute write rate (1.25x input). Cache hits are 0.1x
  // input, 0.05x on Opus 5.5 and Sonnet 5.5, 0.025x on Fable and Mythos 5.1 and 5.2.
  "claude-fable-5-2": { input: 8, output: 40, cachedInput: 0.2, cacheWrite: 10 },
  "claude-mythos-5-2": { input: 8, output: 40, cachedInput: 0.2, cacheWrite: 10 },
  "claude-fable-5-1": { input: 10, output: 50, cachedInput: 0.25, cacheWrite: 12.5 },
  "claude-mythos-5-1": { input: 10, output: 50, cachedInput: 0.25, cacheWrite: 12.5 },
  "claude-fable-5": { input: 10, output: 50, cachedInput: 1, cacheWrite: 12.5 },
  "claude-mythos-5": { input: 10, output: 50, cachedInput: 1, cacheWrite: 12.5 },
  "claude-opus-5-5": { input: 4, output: 20, cachedInput: 0.2, cacheWrite: 5 },
  "claude-opus-5": { input: 5, output: 25, cachedInput: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cachedInput: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-7": { input: 5, output: 25, cachedInput: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-6": { input: 5, output: 25, cachedInput: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-5": { input: 5, output: 25, cachedInput: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-1": { input: 15, output: 75, cachedInput: 1.5, cacheWrite: 18.75 },
  "claude-opus-4": { input: 15, output: 75, cachedInput: 1.5, cacheWrite: 18.75 },
  "claude-sonnet-5-5": { input: 2, output: 10, cachedInput: 0.1, cacheWrite: 2.5 },
  "claude-sonnet-5": { input: 2, output: 10, cachedInput: 0.2, cacheWrite: 2.5 },
  "claude-sonnet-4-6": { input: 3, output: 15, cachedInput: 0.3, cacheWrite: 3.75 },
  "claude-sonnet-4-5": { input: 3, output: 15, cachedInput: 0.3, cacheWrite: 3.75 },
  "claude-sonnet-4": { input: 3, output: 15, cachedInput: 0.3, cacheWrite: 3.75 },
  // Priced by prompt length: over 100k prompt tokens the whole call pays more.
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
  "claude-haiku-4-5": { input: 1, output: 5, cachedInput: 0.1, cacheWrite: 1.25 },

  // OpenAI: https://platform.openai.com/docs/pricing and each model's page under
  // https://platform.openai.com/docs/models (checked 2026-11-09). Standard tier.
  // cacheWrite is the 30-minute write rate (1.25x input) where OpenAI bills
  // writes; older models do not. Over 272k prompt tokens the whole call pays 2x
  // input and cache and 1.5x output. The Codex models gpt-6-sol, gpt-6-luna,
  // gpt-5.6-terra and gpt-5.6-luna: https://developers.openai.com/api/docs/pricing
  // (checked 2026-11-19). `gpt-6-luna` here is the general Responses/Chat price
  // of customer calls; Ratel's own Decisions calls keep the input-only Decisions
  // price of the edition's vendor prices.
  "gpt-6-astra": {
    input: 10,
    output: 50,
    cachedInput: 1,
    cacheWrite: 12.5,
    longContext: { threshold: 272_000, input: 20, output: 75, cachedInput: 2, cacheWrite: 25 },
  },
  "gpt-6.1-sol": {
    input: 2,
    output: 10,
    cachedInput: 0.1,
    cacheWrite: 2.5,
    longContext: { threshold: 272_000, input: 4, output: 15, cachedInput: 0.2, cacheWrite: 5 },
  },
  "gpt-6.1-terra": {
    input: 1,
    output: 5,
    cachedInput: 0.05,
    cacheWrite: 1.25,
    longContext: { threshold: 272_000, input: 2, output: 7.5, cachedInput: 0.1, cacheWrite: 2.5 },
  },
  "gpt-6-sol": {
    input: 2,
    output: 10,
    cachedInput: 0.2,
    cacheWrite: 2.5,
    longContext: { threshold: 272_000, input: 4, output: 15, cachedInput: 0.4, cacheWrite: 5 },
  },
  "gpt-6-luna": {
    input: 0.1,
    output: 0.5,
    cachedInput: 0.01,
    cacheWrite: 0.125,
    longContext: {
      threshold: 272_000,
      input: 0.2,
      output: 0.75,
      cachedInput: 0.02,
      cacheWrite: 0.25,
    },
  },
  // Promotional price until 2026-11-30 (then $5/$30). `gpt-5.6` routes to Sol.
  "gpt-5.6-sol": {
    input: 4,
    output: 20,
    cachedInput: 0.4,
    cacheWrite: 5,
    longContext: { threshold: 272_000, input: 8, output: 30, cachedInput: 0.8, cacheWrite: 10 },
  },
  "gpt-5.6": {
    input: 4,
    output: 20,
    cachedInput: 0.4,
    cacheWrite: 5,
    longContext: { threshold: 272_000, input: 8, output: 30, cachedInput: 0.8, cacheWrite: 10 },
  },
  "gpt-5.6-terra": {
    input: 2,
    output: 12,
    cachedInput: 0.2,
    cacheWrite: 2.5,
    longContext: { threshold: 272_000, input: 4, output: 18, cachedInput: 0.4, cacheWrite: 5 },
  },
  "gpt-5.6-luna": {
    input: 0.2,
    output: 1.2,
    cachedInput: 0.02,
    cacheWrite: 0.25,
    longContext: {
      threshold: 272_000,
      input: 0.4,
      output: 1.8,
      cachedInput: 0.04,
      cacheWrite: 0.5,
    },
  },
  "gpt-5.5": {
    input: 5,
    output: 30,
    cachedInput: 0.5,
    longContext: { threshold: 272_000, input: 10, output: 45, cachedInput: 1 },
  },
  // No cached-input discount.
  "gpt-5.5-pro": { input: 30, output: 180, cachedInput: 30 },
  "gpt-5.4": {
    input: 2.5,
    output: 15,
    cachedInput: 0.25,
    longContext: { threshold: 272_000, input: 5, output: 22.5, cachedInput: 0.5 },
  },
  "gpt-5.4-mini": { input: 0.75, output: 4.5, cachedInput: 0.075 },
  "gpt-5.4-nano": { input: 0.2, output: 1.25, cachedInput: 0.02 },
  "gpt-5.3-codex": { input: 1.75, output: 14, cachedInput: 0.175 },
  "gpt-5.2": { input: 1.75, output: 14, cachedInput: 0.175 },
  "gpt-5.1": { input: 1.25, output: 10, cachedInput: 0.125 },
  "gpt-5": { input: 1.25, output: 10, cachedInput: 0.125 },
  "gpt-5-codex": { input: 1.25, output: 10, cachedInput: 0.125 },
  "gpt-5-chat-latest": { input: 1.25, output: 10, cachedInput: 0.125 },
  "gpt-5-mini": { input: 0.25, output: 2, cachedInput: 0.025 },
  "gpt-5-nano": { input: 0.05, output: 0.4, cachedInput: 0.005 },
  "gpt-4.1": { input: 2, output: 8, cachedInput: 0.5 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6, cachedInput: 0.1 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4, cachedInput: 0.025 },
  // gpt-4o-mini is its own entry: a prefix never reaches a named variant, and
  // it costs 1/16 of gpt-4o.
  "gpt-4o": { input: 2.5, output: 10, cachedInput: 1.25 },
  // The first gpt-4o snapshot kept its launch price and had no cache discount.
  "gpt-4o-2024-05-13": { input: 5, output: 15 },
  "gpt-4o-mini": { input: 0.15, output: 0.6, cachedInput: 0.075 },
  o1: { input: 15, output: 60, cachedInput: 7.5 },
  "o1-mini": { input: 1.1, output: 4.4, cachedInput: 0.55 },
  o3: { input: 2, output: 8, cachedInput: 0.5 },
  // No cached-input price published.
  "o3-pro": { input: 20, output: 80 },
  "o3-mini": { input: 1.1, output: 4.4, cachedInput: 0.55 },
  "o4-mini": { input: 1.1, output: 4.4, cachedInput: 0.275 },
  "chat-latest": { input: 5, output: 30, cachedInput: 0.5 },

  // Google Gemini: https://ai.google.dev/gemini-api/docs/pricing (checked
  // 2026-11-09). Paid tier, standard, text input. cachedInput is the context
  // caching rate (storage per hour is not a token price). Gemini 4 Argon and
  // the 3.6 and 3.8 Flash models are at introductory prices that double on the
  // date noted: update them then.
  "gemini-4-argon": { input: 2, output: 10, cachedInput: 0.1 }, // 4/20/0.2 from 2026-12-01
  "gemini-3.8-flash": { input: 0.75, output: 3.75, cachedInput: 0.075 }, // 1.5/7.5/0.15 from 2027-01-01
  "gemini-3.6-flash": { input: 0.75, output: 3.75, cachedInput: 0.075 }, // 1.5/7.5/0.15 from 2027-01-01
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5, cachedInput: 0.03 },
  "gemini-3.1-flash-lite": { input: 0.25, output: 1.5, cachedInput: 0.025 },
  "gemini-3.1-pro-preview": {
    input: 2,
    output: 12,
    cachedInput: 0.2,
    longContext: { threshold: 200_000, input: 4, output: 18, cachedInput: 0.4 },
  },
  "gemini-3-flash-preview": { input: 0.5, output: 3, cachedInput: 0.05 },
  "gemini-2.5-pro": {
    input: 1.25,
    output: 10,
    cachedInput: 0.125,
    longContext: { threshold: 200_000, input: 2.5, output: 15, cachedInput: 0.25 },
  },
  "gemini-2.5-flash": { input: 0.3, output: 2.5, cachedInput: 0.03 },
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4, cachedInput: 0.01 },

  // Mistral: each model's card under https://docs.mistral.ai/models (checked
  // 2026-11-09). Mistral publishes no per-model cache rate, so cached input
  // bills at input.
  "mistral-medium-3-5": { input: 1.5, output: 7.5 },
  "mistral-small-2603": { input: 0.15, output: 0.6 },
  "mistral-large-2512": { input: 0.5, output: 1.5 },
  "codestral-2508": { input: 0.3, output: 0.9 },
  "ministral-14b-2512": { input: 0.2, output: 0.2 },
  "ministral-8b-2512": { input: 0.15, output: 0.15 },
  "ministral-3b-2512": { input: 0.1, output: 0.1 },

  // xAI: https://docs.x.ai/developers/pricing (checked 2026-11-09). A prompt
  // that reaches 200k tokens bills the whole call at the long-context rates.
  "grok-4.7": {
    input: 2,
    output: 6,
    cachedInput: 0.5,
    longContext: { threshold: 199_999, input: 4, output: 12, cachedInput: 1 },
  },
  "grok-4.6": {
    input: 2,
    output: 6,
    cachedInput: 0.5,
    longContext: { threshold: 199_999, input: 4, output: 12, cachedInput: 1 },
  },
  "grok-4.5": {
    input: 2,
    output: 6,
    cachedInput: 0.3,
    longContext: { threshold: 199_999, input: 4, output: 12, cachedInput: 0.6 },
  },
  "grok-4.3": {
    input: 1.25,
    output: 2.5,
    cachedInput: 0.2,
    longContext: { threshold: 199_999, input: 2.5, output: 5, cachedInput: 0.4 },
  },
  "grok-4.20": {
    input: 1.25,
    output: 2.5,
    cachedInput: 0.2,
    longContext: { threshold: 199_999, input: 2.5, output: 5, cachedInput: 0.4 },
  },
  "grok-4.20-0309-reasoning": {
    input: 1.25,
    output: 2.5,
    cachedInput: 0.2,
    longContext: { threshold: 199_999, input: 2.5, output: 5, cachedInput: 0.4 },
  },
  "grok-4.20-0309-non-reasoning": {
    input: 1.25,
    output: 2.5,
    cachedInput: 0.2,
    longContext: { threshold: 199_999, input: 2.5, output: 5, cachedInput: 0.4 },
  },
  "grok-4.20-multi-agent-0309": {
    input: 1.25,
    output: 2.5,
    cachedInput: 0.2,
    longContext: { threshold: 199_999, input: 2.5, output: 5, cachedInput: 0.4 },
  },
  "grok-build-0.1": {
    input: 1,
    output: 2,
    cachedInput: 0.2,
    longContext: { threshold: 199_999, input: 2, output: 4, cachedInput: 0.4 },
  },

  // DeepSeek: https://api-docs.deepseek.com/quick_start/pricing (checked
  // 2026-11-09). The peak-hour list price; off-peak hours bill half.
  // `deepseek-v4-flash` is a legacy name served and billed as deepseek-flash.
  "deepseek-flash": { input: 0.3, output: 1.2, cachedInput: 0.006 },
  "deepseek-v4-flash": { input: 0.3, output: 1.2, cachedInput: 0.006 },
  "deepseek-v4-pro": { input: 1.32, output: 3.96, cachedInput: 0.044 },
};

/**
 * The model aliases of Claude Code and the Claude Agent SDK (AOBS-3): a harness
 * that reports the picker alias as the model id sends `opus`, not
 * `claude-opus-5-5`. An alias names the newest model of its family, so it
 * prices as that model's {@link MODEL_PRICES} key (and as the project's own
 * price of that key).
 * The match is exact: `opus-custom` is not an alias.
 * A call made while the alias named an older model is priced at the newest
 * one; an emitter that sends the resolved id avoids that. Move a target here
 * when a family gets a newer model.
 */
export const CLAUDE_MODEL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  opus: "claude-opus-5-5",
  "opus[1m]": "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  "sonnet[1m]": "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
  fable: "claude-fable-5-2",
  mythos: "claude-mythos-5-2",
});

/**
 * A date after a known id, and nothing else: `-2024-08-06`, `-20250929`,
 * `@20250929`, `-2508` (YYMM), with an optional Bedrock `-v1:0`. A word
 * (`-mini`, `-pro`) or a minor version (`.2`, `-6`) is a different model, so
 * `gpt-5.2` never prices as `gpt-5` and `claude-opus-5-6` never as `claude-opus-5`.
 */
const DATE_SUFFIX = /^[-@](?:\d{4}-\d{2}-\d{2}|\d{8}|\d{4})(?:-v\d+(?::\d+)?)?$/;

/**
 * Resolve a model id to its price: exact match, then the longest key the id
 * extends by a date only. The project's overrides (`book`) join the current
 * table and win on the same key, so an override of `gpt-4o` also prices
 * `gpt-4o-2024-08-06`. No book: the current table alone.
 */
export function priceFor(
  model: string | null | undefined,
  book?: PriceBook | null,
): ModelPrice | null {
  return resolvePrice(model, book)?.price ?? null;
}

/** {@link priceFor}, with the key that priced the model and where it came from. */
export function resolvePrice(
  model: string | null | undefined,
  book?: PriceBook | null,
): ResolvedPrice | null {
  if (!model) return null;
  const { overrides } = book ?? CURRENT_PRICES;
  if (overrides[model]) return { key: model, price: overrides[model], source: "custom" };
  // A project's own price of the alias itself won above; else the alias prices as the model it names.
  model = CLAUDE_MODEL_ALIASES[model] ?? model;
  if (overrides[model]) return { key: model, price: overrides[model], source: "custom" };
  if (MODEL_PRICES[model]) return { key: model, price: MODEL_PRICES[model], source: "built-in" };
  let best: ResolvedPrice | null = null;
  for (const [table, source] of [
    [overrides, "custom"],
    [MODEL_PRICES, "built-in"],
  ] as const) {
    for (const [key, price] of Object.entries(table)) {
      if (!model.startsWith(key) || !DATE_SUFFIX.test(model.slice(key.length))) continue;
      // `>`: on a tie the override (seen first) keeps the slot.
      if (!best || key.length > best.key.length) best = { key, price, source };
    }
  }
  return best;
}

/** Whether `model` is `key` or `key` with a date after it: the ids one price key prices. */
export function extendsByDate(model: string, key: string): boolean {
  return model === key || (model.startsWith(key) && DATE_SUFFIX.test(model.slice(key.length)));
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
  book?: PriceBook | null,
): number | null {
  return costAt(priceFor(model, book), usage);
}

/** What `usage` costs at `base`, rounded to the stored precision; null without a price or usage. */
function costAt(base: ModelPrice | null, usage: CostUsage | null | undefined): number | null {
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

/**
 * Ratel's own budget rates: what Ratel's own model calls cost (evals, replays,
 * fix drafts, the decision engines) and what their spend caps count. These are
 * NOT customer prices: a customer's model call uses {@link MODEL_PRICES} and
 * the project's own prices. They are the frozen rates of the table before
 * RC-482, kept so that Ratel's internal costs and caps do not move. Do not
 * edit them to correct a customer price.
 */
export const RATEL_BUDGET_PRICES: Readonly<Record<string, ModelPrice>> = Object.freeze({
  // Anthropic — cache reads at ~1/10 of input.
  "claude-opus-4-8": { input: 5, output: 25, cachedInput: 0.5, cacheWrite: 6.25 },
  // https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-10-31).
  "claude-opus-5-5": { input: 4, output: 20, cachedInput: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cachedInput: 0.2 },
  // https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-11-01).
  // cacheWrite is the 5-minute write rate (1.25x input).
  "claude-opus-5": { input: 5, output: 25, cachedInput: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5": { input: 2, output: 10, cachedInput: 0.2, cacheWrite: 2.5 },
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
});

/**
 * What one of Ratel's own model calls costs at {@link RATEL_BUDGET_PRICES}:
 * exact match, then the longest key the id starts with, whatever follows it.
 * Null when no key prices the model.
 */
export function ratelBudgetCostFor(
  model: string | null | undefined,
  usage: CostUsage | null | undefined,
): number | null {
  if (!model) return null;
  return costAt(ratelBudgetPriceFor(model), usage);
}

function ratelBudgetPriceFor(model: string): ModelPrice | null {
  const exact = RATEL_BUDGET_PRICES[model];
  if (exact) return exact;
  let best: { key: string; price: ModelPrice } | null = null;
  for (const [key, price] of Object.entries(RATEL_BUDGET_PRICES)) {
    if (model.startsWith(key) && (!best || key.length > best.key.length)) best = { key, price };
  }
  return best?.price ?? null;
}
