import assert from "node:assert/strict";
import { test } from "node:test";
import { promptCacheHitRate } from "@/lib/synthesis/dashboard";

/** RC-382: the share of the window's input tokens served from the prompt cache. */

test("the rate is cached over input for the window", () => {
  assert.equal(promptCacheHitRate({ cachedTokens: 900, inputTokens: 1_050 }), 900 / 1_050);
});

test("no input is no rate", () => {
  assert.equal(promptCacheHitRate({ cachedTokens: 0, inputTokens: 0 }), null);
  assert.equal(promptCacheHitRate(null), null);
});

test("the rate never passes 1, even if a row reports more cached than input", () => {
  assert.equal(promptCacheHitRate({ cachedTokens: 1_200, inputTokens: 1_000 }), 1);
});
