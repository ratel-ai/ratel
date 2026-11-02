import assert from "node:assert/strict";
import test from "node:test";
import { describePrice, roundTripPriceOf } from "@/lib/synthesis/tool-crafter/round-trip";
import { gainOf, suggestionView } from "@/lib/synthesis/tool-crafter/suggestion-model";
import type { CraftCardModel } from "@/lib/synthesis/tool-crafter/view";

const card = (evidence: CraftCardModel["evidence"], kind: CraftCardModel["kind"]): CraftCardModel =>
  ({
    id: "p",
    kind,
    status: "pending",
    draftedBy: "rules",
    sources: [],
    crafted: [],
    hidden: [],
    rationale: "",
    details: "",
    expectedEffect: "",
    migrationNotes: "",
    evidence,
    backtest: null,
    createdAt: new Date(0),
  }) as unknown as CraftCardModel;

test("the round-trip price comes from the linked days: ms per model call, dollars per priced call", () => {
  const daily = [
    {
      linked: {
        runs: 10,
        modelCalls: 40,
        pricedRuns: 10,
        costUsd: 0.8,
        modelMs: 60_000,
        inputTokens: 200_000,
        outputTokens: 8_000,
      },
    },
    {
      linked: {
        runs: 10,
        modelCalls: 40,
        pricedRuns: 0,
        costUsd: 0,
        modelMs: 40_000,
        inputTokens: 120_000,
        outputTokens: 4_000,
      },
    },
    { day: "no linked runs" },
  ];
  assert.deepEqual(
    roundTripPriceOf(daily),
    { ms: 1250, usd: 0.02, inputTokens: 4_000, outputTokens: 150, modelCalls: 80 },
    "80 calls, 100 s, 320k tokens in and 12k out; the 40 priced calls cost 0.80",
  );
  assert.deepEqual(
    roundTripPriceOf([{ linked: { runs: 2, modelCalls: 6, pricedRuns: 0, costUsd: 0 } }]),
    { ms: null, usd: null, inputTokens: null, outputTokens: null, modelCalls: 6 },
    "old buckets carry no model time or tokens; nothing priced",
  );
  assert.deepEqual(roundTripPriceOf([]), {
    ms: null,
    usd: null,
    inputTokens: null,
    outputTokens: null,
    modelCalls: 0,
  });
  assert.equal(
    describePrice(roundTripPriceOf(daily)),
    "Priced from 80 model calls the agent made in this window: 4.2k tokens, 1.3 s, $0.020 each.",
  );
  assert.equal(
    describePrice(
      roundTripPriceOf([{ linked: { runs: 2, modelCalls: 6, pricedRuns: 0, costUsd: 0 } }]),
    ),
    "Priced from 6 model calls the agent made in this window; neither timed nor priced.",
  );
  assert.equal(describePrice(roundTripPriceOf([])), null);
});

test("a suggestion's gain prices the removed round-trips: enrich, compose and tighten over the window", () => {
  const price = { ms: 1250, usd: 0.02, inputTokens: 4_000, outputTokens: 150, modelCalls: 80 };
  const enrich = card(
    {
      kind: "enrich_response",
      enrich: {
        intentId: "i",
        intentText: "close out",
        units: 20,
        a: "ctx",
        b: "projects",
        n: 19,
        na: 20,
        bMedianMs: 300,
        bUnitsOutside: 5,
      },
    },
    "enrich_response",
  );
  assert.deepEqual(gainOf(enrich, price), {
    occurrences: 19,
    calls: 19,
    roundTrips: 19,
    ms: 19 * 300 + 19 * 1250,
    usd: 0.38,
    tokens: { input: 76_000, output: 2_850 },
  });
  assert.deepEqual(
    gainOf(enrich),
    { occurrences: 19, calls: 19, roundTrips: 19, ms: 19 * 300, usd: null, tokens: null },
    "unpriced: the tool's own time only",
  );
  const view = suggestionView(enrich, (id) => id, [], { price });
  assert.deepEqual(
    view.effects.map((c) => c.text),
    ["2 calls → 1", "−1 round-trip", "−300 ms waiting"],
    "what one turn saves, once",
  );
  assert.equal(view.unit, "per turn");
  assert.equal(view.windowLabel, "over the window · 19 turns");
  assert.deepEqual(
    view.windowEffects.map((c) => c.text),
    ["−19 round-trips (24%)", "−29 s waiting", "−79k tokens", "−$0.380"],
    "what the window adds up to, once",
  );
  assert.match(
    view.windowEffects[0]!.title ?? "",
    /24% of the window's 80 model calls · 1.3 s each/,
    "the share anchors the size",
  );
  assert.match(
    view.windowEffects[2]!.title ?? "",
    /19 round-trips × 4.2k tokens per model call in this project \(76k in, 2.9k out\)/,
    "the derivation lives in the tooltip",
  );
  assert.match(
    view.plain,
    /^After the first tool answers, the agent always calls the second one to fetch one more thing/,
  );
  assert.equal(
    view.savingMs,
    19 * 300 + 19 * 1250,
    "the window saving carries the round-trips, so a priced project orders by them",
  );
  assert.deepEqual(
    view.glance.map((c) => [c.icon, c.text]),
    [
      ["calls", "2 → 1"],
      ["cost", "−$0.380"],
    ],
    "priced: dollars beat tokens in the closed row",
  );
  const compose = card(
    {
      kind: "compose_chain",
      compose: {
        workflowId: "w",
        order: ["a", "b", "c", "d"],
        runs: 52,
        orderStability: 0.9,
        medianMs: 2100,
        medianModelCalls: 5,
        medianCostUsd: 0.02,
      },
    },
    "compose_chain",
  );
  assert.deepEqual(
    gainOf(compose, price),
    {
      occurrences: 52,
      calls: 156,
      roundTrips: 195,
      ms: 195 * 1250,
      usd: 3.9,
      tokens: { input: 780_000, output: 29_250 },
    },
    "5 model calls become 1.25 per run: 3.75 fewer, over 52 runs",
  );
  const tighten = card(
    {
      kind: "tighten_schema",
      tighten: {
        calls: 33,
        errorCalls: 11,
        retriedErrors: 10,
        recoveredRetries: 10,
        undocumentedArgs: [],
        freeTextArgs: [],
        requiredArgs: [],
      },
    },
    "tighten_schema",
  );
  assert.deepEqual(gainOf(tighten, price), {
    occurrences: 10,
    calls: 10,
    roundTrips: 10,
    ms: 12_500,
    usd: 0.2,
    tokens: { input: 40_000, output: 1_500 },
  });
});
