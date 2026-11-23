import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHARS_PER_TOKEN,
  DEFAULT_INPUT_PRICE_PER_MTOK,
  entryPromptTokens,
  estimateSavings,
  estimateTokens,
  projectMonthly,
  SAVINGS_BASELINE,
  SAVINGS_BASELINE_NOTE,
  speedup,
} from "@/lib/synthesis/quality/tokens";

test("estimateTokens rounds up so a short string never costs nothing", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("a"), 1);
  assert.equal(estimateTokens("a".repeat(CHARS_PER_TOKEN * 3)), 3);
});

test("entryPromptTokens counts the agent description and the schema", () => {
  const withoutSchema = entryPromptTokens({
    name: "create_task",
    description: "Creates a task.",
  });
  const withSchema = entryPromptTokens({
    name: "create_task",
    description: "Creates a task.",
    inputSchema: { type: "object", properties: { title: { type: "string" } } },
  });

  assert.ok(withSchema > withoutSchema);
});

test("estimateSavings reports the catalog the agent did not have to carry", () => {
  const savings = estimateSavings({
    fullCatalogTokens: 10_000,
    averageReturned: 5,
    entryCount: 100,
    searchCount: 200,
  });

  // Five of a hundred entries returned, so 5% of the catalog shipped.
  assert.equal(savings.servedTokens, 500);
  assert.equal(savings.savedPerSearch, 9_500);
  assert.equal(savings.savedTotal, 1_900_000);
  assert.ok(Math.abs(savings.savedShare - 0.95) < 1e-9);
  assert.equal(savings.pricePerMtok, DEFAULT_INPUT_PRICE_PER_MTOK);
  assert.ok(Math.abs(savings.savedUsd - 1.9 * DEFAULT_INPUT_PRICE_PER_MTOK) < 1e-9);
});

test("estimateSavings defaults to modelled and unrealized", () => {
  const savings = estimateSavings({
    fullCatalogTokens: 100,
    averageReturned: 1,
    entryCount: 10,
    searchCount: 1,
  });

  assert.equal(savings.basis, "modelled");
  // A shadow-only arm serves nothing, so the saving is a counterfactual until
  // the caller says otherwise.
  assert.equal(savings.realized, false);
});

test("estimateSavings never reports a negative saving", () => {
  // An arm returning more results than the catalog holds is nonsense input, and
  // must clamp rather than produce a negative headline.
  const savings = estimateSavings({
    fullCatalogTokens: 1_000,
    averageReturned: 500,
    entryCount: 10,
    searchCount: 5,
  });

  assert.equal(savings.savedPerSearch, 0);
  assert.equal(savings.savedTotal, 0);
  assert.equal(savings.savedUsd, 0);
});

test("estimateSavings handles an empty catalog without dividing by zero", () => {
  const savings = estimateSavings({
    fullCatalogTokens: 0,
    averageReturned: 0,
    entryCount: 0,
    searchCount: 10,
  });

  assert.equal(savings.servedTokens, 0);
  assert.equal(savings.savedShare, 0);
  assert.equal(savings.savedUsd, 0);
});

test("estimateSavings honours a caller-supplied price", () => {
  const savings = estimateSavings({
    fullCatalogTokens: 1_000_000,
    averageReturned: 0,
    entryCount: 100,
    searchCount: 1,
    pricePerMtok: 15,
  });

  assert.equal(savings.savedUsd, 15);
});

test("speedup reports the multiple, and refuses nonsense", () => {
  assert.equal(speedup(1500, 44), 1500 / 44);
  assert.equal(speedup(null, 44), null);
  assert.equal(speedup(1500, null), null);
  assert.equal(speedup(1500, 0), null);
  assert.equal(speedup(0, 44), null);
});

test("projectMonthly restates the saving as a run rate", () => {
  const savings = estimateSavings({
    fullCatalogTokens: 10_000,
    averageReturned: 5,
    entryCount: 100,
    searchCount: 140,
    pricePerMtok: 3,
  });

  const monthly = projectMonthly(savings, 14)!;
  assert.equal(monthly.searchesPerDay, 10);
  assert.equal(monthly.searchesPerMonth, 300);
  // 9,500 saved per search across 300 searches.
  assert.equal(monthly.tokensPerMonth, 2_850_000);
  assert.ok(Math.abs(monthly.usdPerMonth - 8.55) < 1e-9);
});

test("projectMonthly refuses a window or population it cannot divide", () => {
  const savings = estimateSavings({
    fullCatalogTokens: 10_000,
    averageReturned: 5,
    entryCount: 100,
    searchCount: 0,
  });
  assert.equal(projectMonthly(savings, 14), null);

  const populated = estimateSavings({
    fullCatalogTokens: 10_000,
    averageReturned: 5,
    entryCount: 100,
    searchCount: 10,
  });
  assert.equal(projectMonthly(populated, 0), null);
});

test("the savings baseline names the catalog, not the other arm", () => {
  // Both surfaces put the incumbent's search beside ours, so a saving stated
  // without its baseline reads as "cheaper than legacy". It is not: the thing
  // retrieval replaces is handing the model every tool.
  assert.match(SAVINGS_BASELINE, /catalog/i);
  assert.match(SAVINGS_BASELINE_NOTE, /entire catalog/i);
  assert.match(SAVINGS_BASELINE_NOTE, /not against the other arm/i);
});
