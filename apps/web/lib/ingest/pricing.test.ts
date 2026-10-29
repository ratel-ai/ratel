import assert from "node:assert/strict";
import { test } from "node:test";
import { costFor, priceFor } from "@/lib/ingest/pricing";

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
