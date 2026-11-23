import assert from "node:assert/strict";
import { test } from "node:test";

// Owned (ADR-0004): upstream's cases, less the vendor prices of Ratel's own model calls, which
// live with their clients in the private edition (`ee/src/src/observability/pricing.ts`).
import {
  CURRENT_PRICES,
  costFor,
  type PriceBook,
  priceFor,
  ratelBudgetCostFor,
  resolvePrice,
} from "@/lib/ingest/pricing";

test("costFor charges input + output at model rates", () => {
  // claude-opus-4-8: $5/Mtok in, $25/Mtok out.
  const usd = costFor("claude-opus-4-8", { input_tokens: 1_000_000, output_tokens: 1_000_000 });
  assert.equal(usd, 30);
});

test("costFor discounts cached input tokens", () => {
  // 1M input of which 1M cached → cached rate $0.5/Mtok, no output.
  const usd = costFor("claude-opus-4-8", {
    input_tokens: 1_000_000,
    output_tokens: 0,
    cached_tokens: 1_000_000,
  });
  assert.equal(usd, 0.5);
});

test("costFor bills claude-opus-4-8 cache writes at $6.25/Mtok", () => {
  const usd = costFor("claude-opus-4-8", {
    input_tokens: 1_000_000,
    output_tokens: 0,
    cache_write_tokens: 1_000_000,
  });
  assert.equal(usd, 6.25);
});

test("cached_tokens never exceeds input_tokens", () => {
  const usd = costFor("gpt-5.5", {
    input_tokens: 100,
    output_tokens: 0,
    cached_tokens: 1000,
  });
  // clamps cached to 100 → 100 * 1.25/1e6
  assert.equal(
    usd,
    costFor("gpt-5.5", { input_tokens: 100, cached_tokens: 100, output_tokens: 0 }),
  );
});

test("priceFor resolves by longest prefix", () => {
  assert.equal(priceFor("gpt-5.5-2026-02-01"), priceFor("gpt-5.5"));
  assert.notEqual(priceFor("gpt-5-mini"), priceFor("gpt-5"));
});

test("unknown model is unpriced", () => {
  assert.equal(priceFor("llama-9000"), null);
  assert.equal(costFor("llama-9000", { input_tokens: 100, output_tokens: 100 }), null);
});

test("claude-haiku-5-5 is priced, including dated ids", () => {
  assert.ok(priceFor("claude-haiku-5-5"));
  assert.equal(priceFor("claude-haiku-5-5-20261001"), priceFor("claude-haiku-5-5"));
  // Not confused with the older Haiku.
  assert.notEqual(priceFor("claude-haiku-5-5"), priceFor("claude-haiku-4-5"));
});

test("claude-haiku-5-5 bills prompts up to 100k at base rates", () => {
  // 100k in (exactly the threshold) at $0.10 + 10k out at $0.50.
  const usd = costFor("claude-haiku-5-5", { input_tokens: 100_000, output_tokens: 10_000 });
  assert.equal(usd, 0.015);
});

test("claude-haiku-5-5 bills the whole call at long-context rates over 100k", () => {
  // 200k in at $0.50 + 10k out at $2.50.
  const usd = costFor("claude-haiku-5-5", { input_tokens: 200_000, output_tokens: 10_000 });
  assert.equal(usd, 0.125);
});

test("long-context threshold counts cache reads and writes", () => {
  // 120k prompt, 90k of it a cache hit and 20k a cache write: still over 100k.
  // 10k uncached * 0.50 + 90k read * 0.05 + 20k write * 0.625 + 1k out * 2.50
  const usd = costFor("claude-haiku-5-5", {
    input_tokens: 120_000,
    output_tokens: 1_000,
    cached_tokens: 90_000,
    cache_write_tokens: 20_000,
  });
  assert.equal(usd, 0.0245);
});

test("cache writes bill at the write rate and never exceed uncached input", () => {
  // 50k prompt: 40k written at $0.125, 10k uncached at $0.10.
  assert.equal(
    costFor("claude-haiku-5-5", {
      input_tokens: 50_000,
      output_tokens: 0,
      cache_write_tokens: 40_000,
    }),
    0.006,
  );
  // Writes clamp to what cache reads leave of the input.
  assert.equal(
    costFor("claude-haiku-5-5", {
      input_tokens: 1_000,
      output_tokens: 0,
      cached_tokens: 800,
      cache_write_tokens: 5_000,
    }),
    costFor("claude-haiku-5-5", {
      input_tokens: 1_000,
      output_tokens: 0,
      cached_tokens: 800,
      cache_write_tokens: 200,
    }),
  );
});

test("models without a cache-write rate bill writes at input", () => {
  assert.equal(
    costFor("gpt-5.5", {
      input_tokens: 1_000_000,
      output_tokens: 0,
      cache_write_tokens: 1_000_000,
    }),
    costFor("gpt-5.5", { input_tokens: 1_000_000, output_tokens: 0 }),
  );
});

test("claude-sonnet-5 is priced at $2/$10, cache reads $0.20 and writes $2.50", () => {
  // The default model of the workflow labels, intent names and topic names.
  assert.equal(
    costFor("claude-sonnet-5", { input_tokens: 1_000_000, output_tokens: 1_000_000 }),
    12,
  );
  assert.equal(
    costFor("claude-sonnet-5", {
      input_tokens: 1_000_000,
      output_tokens: 0,
      cached_tokens: 1_000_000,
    }),
    0.2,
  );
  assert.equal(
    costFor("claude-sonnet-5", {
      input_tokens: 1_000_000,
      output_tokens: 0,
      cache_write_tokens: 1_000_000,
    }),
    2.5,
  );
});

test("claude-opus-5 is priced at $5/$25, cache reads $0.50 and writes $6.25", () => {
  // The default model of the match-quality analyst.
  assert.equal(costFor("claude-opus-5", { input_tokens: 1_000_000, output_tokens: 1_000_000 }), 30);
  assert.equal(
    costFor("claude-opus-5", {
      input_tokens: 1_000_000,
      output_tokens: 0,
      cached_tokens: 1_000_000,
    }),
    0.5,
  );
  assert.equal(
    costFor("claude-opus-5", {
      input_tokens: 1_000_000,
      output_tokens: 0,
      cache_write_tokens: 1_000_000,
    }),
    6.25,
  );
});

test("the 5.5 models keep their own prices next to their 5 prefixes", () => {
  assert.notEqual(priceFor("claude-sonnet-5-5"), priceFor("claude-sonnet-5"));
  assert.notEqual(priceFor("claude-opus-5-5"), priceFor("claude-opus-5"));
  assert.equal(priceFor("claude-opus-5-5-20261001"), priceFor("claude-opus-5-5"));
});

// RC-482: a customer cost uses the current table and the date-only lookup,
// with the project's own prices when it has a book. Ratel's own budget costs
// keep the frozen rates below (`RATEL_BUDGET_PRICES`).

const C = CURRENT_PRICES;
const own = (overrides: PriceBook["overrides"]): PriceBook => ({ overrides });
const M = { input_tokens: 1_000_000, output_tokens: 1_000_000 };

test("with no book a cost uses the current table and the date-only lookup", () => {
  assert.equal(costFor("gpt-5.5", { input_tokens: 100_000, output_tokens: 0 }), 0.5);
  assert.equal(costFor("gpt-4o", M), 12.5);
  assert.equal(costFor("gpt-5.5-turbo", M), null);
  assert.equal(costFor("gpt-5-mini", M), costFor("gpt-5-mini", M, C));
});

test("Ratel's own budget costs keep the frozen rates and the any-suffix lookup", () => {
  assert.equal(ratelBudgetCostFor("gpt-5.5", { input_tokens: 1_000_000, output_tokens: 0 }), 2.5);
  assert.equal(ratelBudgetCostFor("gpt-5.5-pro", M), ratelBudgetCostFor("gpt-5.5", M));
  assert.equal(ratelBudgetCostFor("gpt-5-mini", M), 3);
  assert.equal(ratelBudgetCostFor("gpt-4o", M), null);
  assert.equal(
    ratelBudgetCostFor("claude-opus-5-5", {
      input_tokens: 1_000_000,
      output_tokens: 0,
      cache_write_tokens: 1_000_000,
    }),
    4,
  );
});

test("gpt-4o-mini keeps its own price next to its gpt-4o prefix, dated ids included", () => {
  // gpt-4o: $2.50/$10, gpt-4o-mini: $0.15/$0.60 (platform.openai.com, checked 2026-11-09).
  assert.equal(costFor("gpt-4o", M, C), 12.5);
  assert.equal(costFor("gpt-4o-2024-08-06", M, C), 12.5);
  assert.equal(costFor("gpt-4o-mini", M, C), 0.75);
  assert.equal(costFor("gpt-4o-mini-2024-07-18", M, C), 0.75);
});

test("a prefix prices only a dated id, never a named variant or a newer version", () => {
  // o3-pro is a different, pricier model than o3: unpriced beats a wrong price.
  assert.equal(priceFor("o3-2025-04-16", C), priceFor("o3", C));
  assert.equal(priceFor("claude-sonnet-4-5-20250929", C), priceFor("claude-sonnet-4-5", C));
  assert.equal(priceFor("claude-sonnet-4-5@20250929", C), priceFor("claude-sonnet-4-5", C));
  assert.equal(priceFor("claude-sonnet-4-5-20250929-v1:0", C), priceFor("claude-sonnet-4-5", C));
  assert.equal(priceFor("mistral-medium-3-5-2604", C), priceFor("mistral-medium-3-5", C));
  // A minor version is a different model, not a date.
  for (const model of [
    "gpt-5.7",
    "gpt-5.3",
    "claude-opus-5-6",
    "claude-sonnet-5-6",
    "claude-opus-4-2",
    "gpt-6-astra-1",
    "o3-deep-research",
    "gpt-5.5-turbo",
  ]) {
    assert.equal(priceFor(model, C), null, `${model} stays unpriced`);
  }
});

test("each minor version has its own official price", () => {
  // platform.openai.com model pages, checked 2026-11-09.
  assert.equal(costFor("gpt-5.1", M, C), 11.25);
  assert.equal(costFor("gpt-5.2", M, C), 15.75);
  assert.equal(costFor("gpt-5.6", M, C), costFor("gpt-5.6-sol", M, C));
  assert.equal(costFor("gpt-5-codex", M, C), 11.25);
  assert.equal(costFor("gpt-5-chat-latest", M, C), 11.25);
  assert.equal(costFor("gpt-5.5-pro", M, C), 210);
  assert.equal(costFor("o3-pro", M, C), 100);
  // The first gpt-4o snapshot kept its launch price.
  assert.equal(costFor("gpt-4o-2024-05-13", M, C), 20);
});

test("a project override wins over the built-in price, for dated ids too", () => {
  const book = own({ "gpt-4o": { input: 1, output: 2 } });
  assert.equal(costFor("gpt-4o", M, book), 3);
  assert.equal(costFor("gpt-4o-2024-08-06", M, book), 3);
  // The override of gpt-4o does not reach gpt-4o-mini, which keeps its built-in price.
  assert.equal(costFor("gpt-4o-mini", M, book), 0.75);
});

test("a project override prices a model the built-in list does not know", () => {
  const book = own({ "llama-4-maverick": { input: 0.27, output: 0.85, cachedInput: 0.1 } });
  assert.equal(costFor("llama-4-maverick", M, C), null);
  assert.equal(costFor("llama-4-maverick", M, book), 1.12);
});

test("resolvePrice names the key that priced a model and where it came from", () => {
  const book = own({ "gpt-4o": { input: 1, output: 2 } });
  assert.deepEqual(
    [resolvePrice("gpt-4o-2024-08-06", book)?.key, resolvePrice("gpt-4o-2024-08-06", book)?.source],
    ["gpt-4o", "custom"],
  );
  assert.deepEqual(
    [
      resolvePrice("gpt-4o-mini-2024-07-18", book)?.key,
      resolvePrice("gpt-4o-mini-2024-07-18", book)?.source,
    ],
    ["gpt-4o-mini", "built-in"],
  );
  assert.equal(resolvePrice("unknown", book), null);
});

test("claude-sonnet-5-5 reads cache hits at 5% of input", () => {
  // $2 input, cache hits 0.05x = $0.10 (platform.claude.com, checked 2026-11-09).
  assert.equal(
    costFor(
      "claude-sonnet-5-5",
      { input_tokens: 1_000_000, output_tokens: 0, cached_tokens: 1_000_000 },
      C,
    ),
    0.1,
  );
});

test("gpt-5.5 bills prompts over 272k at 2x input, 2x cache and 1.5x output", () => {
  // $5/$30 base; 300k in at $10 + 10k out at $45.
  assert.equal(costFor("gpt-5.5", { input_tokens: 300_000, output_tokens: 10_000 }, C), 3.45);
  // Cached input over 272k: $1.00 (2x $0.50).
  assert.equal(
    costFor("gpt-5.5", { input_tokens: 1_000_000, output_tokens: 0, cached_tokens: 1_000_000 }, C),
    1,
  );
});

test("the main providers' current models are priced", () => {
  for (const model of [
    "gpt-6.1-sol",
    "gpt-5.4-mini",
    "gpt-4.1-nano",
    "o4-mini",
    "claude-fable-5-2",
    "claude-opus-4-6",
    "gemini-4-argon",
    "gemini-3.5-flash-lite",
    "gemini-2.5-pro",
    "mistral-medium-3-5",
    "mistral-small-2603",
    "grok-4.7",
    "grok-4.20-0309-reasoning",
    "deepseek-flash",
    "deepseek-v4-pro",
  ]) {
    assert.ok(priceFor(model, C), `${model} has a price`);
  }
});

// The Codex models (developers.openai.com/api/docs/pricing, standard tier, checked 2026-11-19).
// Each row: 100k in + 100k out, 100k cached reads, 100k cache writes, and 300k in + 10k out over 272k.
for (const [model, base, cached, written, long] of [
  // gpt-6-sol: $2/$10, cache $0.20, write $2.50; long $4/$15.
  ["gpt-6-sol", 1.2, 0.02, 0.25, 1.35],
  // gpt-6-luna: $0.10/$0.50, cache $0.01, write $0.125; long $0.20/$0.75.
  ["gpt-6-luna", 0.06, 0.001, 0.0125, 0.0675],
  // gpt-5.6-terra: $2/$12, cache $0.20, write $2.50; long $4/$18.
  ["gpt-5.6-terra", 1.4, 0.02, 0.25, 1.38],
  // gpt-5.6-luna: $0.20/$1.20, cache $0.02, write $0.25; long $0.40/$1.80.
  ["gpt-5.6-luna", 0.14, 0.002, 0.025, 0.138],
] as const) {
  test(`${model} is priced at its official standard rates`, () => {
    assert.equal(costFor(model, { input_tokens: 100_000, output_tokens: 100_000 }, C), base);
    assert.equal(
      costFor(model, { input_tokens: 100_000, output_tokens: 0, cached_tokens: 100_000 }, C),
      cached,
    );
    assert.equal(
      costFor(model, { input_tokens: 100_000, output_tokens: 0, cache_write_tokens: 100_000 }, C),
      written,
    );
    assert.equal(costFor(model, { input_tokens: 300_000, output_tokens: 10_000 }, C), long);
  });
}

test("the Codex models double their cache rates over 272k prompt tokens", () => {
  // 300k prompt, 200k cache reads and 50k cache writes, 50k uncached; 10k out.
  const usage = {
    input_tokens: 300_000,
    output_tokens: 10_000,
    cached_tokens: 200_000,
    cache_write_tokens: 50_000,
  };
  // gpt-6-sol long: 50k * $4 + 200k * $0.40 + 50k * $5 + 10k * $15.
  assert.equal(costFor("gpt-6-sol", usage, C), 0.68);
  // gpt-5.6-luna long: 50k * $0.40 + 200k * $0.04 + 50k * $0.50 + 10k * $1.80.
  assert.equal(costFor("gpt-5.6-luna", usage, C), 0.071);
});

test("a Claude alias prices as the model it names (AOBS-3)", () => {
  for (const [alias, model] of [
    ["opus", "claude-opus-5-5"],
    ["sonnet", "claude-sonnet-5-5"],
    ["haiku", "claude-haiku-5-5"],
    ["fable", "claude-fable-5-2"],
    ["opus[1m]", "claude-opus-5-5"],
  ] as const) {
    for (const book of [undefined, null, CURRENT_PRICES, { overrides: {} }]) {
      assert.deepEqual(resolvePrice(alias, book), resolvePrice(model), alias);
      assert.equal(resolvePrice(alias, book)?.key, model);
    }
  }
  const usage = { input_tokens: 1_000_000, output_tokens: 0 };
  assert.equal(costFor("opus", usage), costFor("claude-opus-5-5", usage));
});

test("a project's price of the alias, or of the model it names, wins over the built-in alias price", () => {
  const own = { input: 1, output: 2 };
  assert.deepEqual(resolvePrice("opus", { overrides: { opus: own } }), {
    key: "opus",
    price: own,
    source: "custom",
  });
  assert.deepEqual(resolvePrice("opus", { overrides: { "claude-opus-5-5": own } }), {
    key: "claude-opus-5-5",
    price: own,
    source: "custom",
  });
});

test("an alias is not a prefix: a longer id never prices as it", () => {
  assert.equal(resolvePrice("opus-custom"), null);
  assert.equal(resolvePrice("sonnetto"), null);
});
