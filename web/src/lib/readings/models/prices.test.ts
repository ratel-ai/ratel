import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfig } from "@/config";
import { ratelBudgetCostFor } from "@/lib/ingest/pricing";
import { budgetCostFor, FALLBACK_PRICE_MODEL, priceOverrides } from "./prices";

/** The settings `env` resolves to (`web/src/config.ts`). */
const cfg = (env: Record<string, string | undefined> = {}) => resolveConfig({ env });

const USAGE = { inputTokens: 1_000_000, outputTokens: 1_000_000 };

test("a model Ratel prices costs what it costs today", () => {
  assert.equal(
    budgetCostFor("claude-sonnet-5-5", USAGE, cfg({})),
    ratelBudgetCostFor("claude-sonnet-5-5", { input_tokens: 1_000_000, output_tokens: 1_000_000 }),
  );
  assert.equal(budgetCostFor("claude-sonnet-5-5", USAGE, cfg({})), 12);
});

test("cached tokens are a part of input, billed at the cached rate", () => {
  assert.equal(
    budgetCostFor(
      "claude-sonnet-5-5",
      { inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 1_000_000 },
      cfg({}),
    ),
    0.2,
  );
});

test("a model without a price is charged at the fallback price, so a cap still holds", () => {
  const fallback = ratelBudgetCostFor(FALLBACK_PRICE_MODEL, {
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
  });
  assert.equal(budgetCostFor("llama-3.3-70b", USAGE, cfg({})), fallback);
  assert.ok((fallback ?? 0) > 0);
});

test("MODEL_PRICES is read first, in dollars per million tokens, and 0 is a price", () => {
  const env = {
    MODEL_PRICES: JSON.stringify({
      "llama-3.3-70b": { input: 0, output: 0 },
      "gpt-5.5": { input: 1, output: 2, cachedInput: 0.5 },
      "claude-sonnet-5-5": { input: 100, output: 100 },
    }),
  };
  assert.equal(budgetCostFor("llama-3.3-70b", USAGE, cfg(env)), 0);
  assert.equal(budgetCostFor("gpt-5.5", USAGE, cfg(env)), 3);
  assert.equal(
    budgetCostFor(
      "gpt-5.5",
      { inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 400_000 },
      cfg(env),
    ),
    0.8,
  );
  // An override wins over Ratel's own rate for the same id.
  assert.equal(budgetCostFor("claude-sonnet-5-5", USAGE, cfg(env)), 200);
  // An id the override does not name is priced as before.
  assert.equal(budgetCostFor("claude-opus-5-5", USAGE, cfg(env)), 24);
});

test("an unreadable MODEL_PRICES is no override, never a free pass", () => {
  for (const value of ["{not json", "[]", '"x"', "null", "REPLACE_ME"]) {
    assert.deepEqual(priceOverrides(cfg({ MODEL_PRICES: value })), {}, value);
  }
  assert.ok((budgetCostFor("llama-3.3-70b", USAGE, cfg({ MODEL_PRICES: "{not json" })) ?? 0) > 0);
});

test("an entry without a usable input and output price is dropped", () => {
  assert.deepEqual(
    priceOverrides(
      cfg({
        MODEL_PRICES: JSON.stringify({
          good: { input: 1, output: 2 },
          negative: { input: -1, output: 2 },
          missing: { input: 1 },
          text: { input: "1", output: "2" },
          shape: 3,
        }),
      }),
    ),
    { good: { input: 1, output: 2 } },
  );
});

test("a config file gives the prices as an object", () => {
  const config = resolveConfig({
    override: { modelVendor: { prices: { "llama-3.3-70b": { input: 0, output: 0 } } } },
  });
  assert.equal(budgetCostFor("llama-3.3-70b", USAGE, config), 0);
});
