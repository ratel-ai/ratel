import assert from "node:assert/strict";
import { test } from "node:test";
import { createBm25Spotchecker, isInconclusive } from "./preview";
import type { CorpusEntry, EvalItem } from "./types";

const AT = new Date("2026-09-10T12:00:00Z");

function entry(entryId: string, searchable: string): CorpusEntry {
  return {
    entryId,
    name: entryId,
    searchable,
    source: "runtime",
    matchesAgentDescription: true,
    tags: [],
  };
}

function item(
  selectionId: string,
  query: string | null,
  target: string,
  served: string[],
): EvalItem {
  return {
    selectionId,
    occurredAt: AT,
    query,
    targetEntryId: target,
    targetKind: "tool",
    targetSource: "invoked",
    arms: [
      { arm: "ratel", role: "serving", resultIds: served, resultScores: null },
      { arm: "legacy", role: "shadow", resultIds: [target], resultScores: null },
    ],
  };
}

const CORPUS: CorpusEntry[] = [
  entry("refund_payment", "Handles ledger reversal operations."),
  entry("list_invoices", "Lists invoices for an account."),
  entry("cancel_subscription", "Cancels a subscription."),
];

test("a rewrite that adds the user's own words lifts the target's rank", () => {
  const items = [
    item("s1", "give the customer their money back", "refund_payment", ["list_invoices"]),
  ];
  const scorer = createBm25Spotchecker(CORPUS, items, "ratel");

  const preview = scorer.previewFor({
    entryId: "refund_payment",
    searchableDescription:
      "Reverses a charge. Use when the customer wants their money back or asks for a refund.",
  });

  assert.equal(preview.scorer, "bm25-spotcheck");
  assert.equal(preview.hits.length, 1);
  assert.equal(preview.hits[0].before, null);
  assert.equal(preview.hits[0].after, 1);
  assert.equal(preview.improved, 1);
  assert.equal(preview.worsened, 0);
});

test("the preview only scores searches the patched entry was meant to win", () => {
  const items = [
    item("s1", "refund the customer", "refund_payment", ["list_invoices"]),
    item("s2", "show me the invoices", "list_invoices", ["cancel_subscription"]),
  ];
  const scorer = createBm25Spotchecker(CORPUS, items, "ratel");
  const preview = scorer.previewFor({
    entryId: "refund_payment",
    searchableDescription: "Refunds a payment. Use when the customer asks for a refund.",
  });
  assert.equal(preview.hits.length, 1);
  assert.equal(preview.hits[0].query, "refund the customer");
});

test("the reproduction rate measures the unpatched ranker against what was served", () => {
  const items = [
    // BM25 on "invoices" picks list_invoices, which is what was served: a match.
    item("s1", "invoices", "list_invoices", ["list_invoices"]),
    // Served something BM25 would never pick first: a miss.
    item("s2", "invoices", "list_invoices", ["cancel_subscription"]),
  ];
  const scorer = createBm25Spotchecker(CORPUS, items, "ratel");
  assert.equal(scorer.reproductionSample, 2);
  assert.equal(scorer.reproductionRate, 0.5);
});

test("with nothing served to compare against there is no error bar, so nothing is conclusive", () => {
  const items = [item("s1", "refund", "refund_payment", [])];
  const scorer = createBm25Spotchecker(CORPUS, items, "ratel");
  assert.equal(scorer.reproductionRate, null);
  assert.equal(scorer.reproductionSample, 0);
  const preview = scorer.previewFor({
    entryId: "refund_payment",
    searchableDescription: "Refunds a payment. Use when the customer asks for a refund.",
  });
  assert.equal(preview.inconclusive, true);
});

test("uncaptured queries are skipped rather than scored as failures", () => {
  const items = [item("s1", null, "refund_payment", ["list_invoices"])];
  const scorer = createBm25Spotchecker(CORPUS, items, "ratel");
  const preview = scorer.previewFor({
    entryId: "refund_payment",
    searchableDescription: "Refunds a payment.",
  });
  assert.deepEqual(preview.hits, []);
  assert.equal(preview.inconclusive, true);
});

test("repeated phrasings of one query spend one slot", () => {
  const items = [
    item("s1", "refund the customer", "refund_payment", ["list_invoices"]),
    item("s2", "refund the customer", "refund_payment", ["list_invoices"]),
    item("s3", "refund the customer", "refund_payment", ["list_invoices"]),
  ];
  const scorer = createBm25Spotchecker(CORPUS, items, "ratel");
  const preview = scorer.previewFor({
    entryId: "refund_payment",
    searchableDescription: "Refunds a payment. Use when the customer asks for a refund.",
  });
  assert.equal(preview.hits.length, 1);
});

test("movement no bigger than the scorer's own error reads as inconclusive", () => {
  // A scorer that reproduces production 50% of the time has a 50% error rate, so
  // a 50% net improvement is exactly as likely to be the scorer being wrong.
  assert.equal(isInconclusive(10, 5, 0, 0.5), true);
  assert.equal(isInconclusive(10, 6, 0, 0.5), false);
  // A scorer that almost always agrees with production can resolve a small move.
  assert.equal(isInconclusive(10, 2, 0, 0.95), false);
  // Net-negative or net-zero movement is never a win.
  assert.equal(isInconclusive(10, 3, 3, 0.99), true);
  assert.equal(isInconclusive(10, 2, 5, 0.99), true);
  // No sample and no error bar are both unresolvable.
  assert.equal(isInconclusive(0, 0, 0, 0.99), true);
  assert.equal(isInconclusive(10, 9, 0, null), true);
});
