import assert from "node:assert/strict";
import { test } from "node:test";
import { detectDemand } from "@/lib/readings/trace-signals/signals/detect-demand";

const MIX = { declared: 0, inferred: 10, otlp: 0 };
const clusters = (singletons: number, groups: number) => [
  ...Array.from({ length: singletons }, () => ({ memberCount: 1 })),
  ...Array.from({ length: groups }, () => ({ memberCount: 4 })),
];

test("fragmented_intents is measured but never shown: it is the intent engine's state, not the agent's", () => {
  // "Ratel cannot learn from an ask it has only seen once" describes our
  // ranking, not a customer problem; on one WhatsApp agent the "asks" were
  // "sì" and site names. Measuring it resolves any card still open.
  const result = detectDemand(clusters(209, 23), MIX);
  assert.equal(result.signals.length, 0);
  assert.ok(result.measured.has("fragmented_intents"));
});

test("fragmented_intents is skipped without a graph and quiet under its floors", () => {
  assert.equal(detectDemand(null, MIX).measured.size, 0);
  assert.equal(detectDemand([], MIX).measured.size, 0);
  const small = detectDemand(clusters(15, 4), MIX);
  assert.equal(small.signals.length, 0, "19 clusters < 20");
  assert.ok(small.measured.has("fragmented_intents"));
  assert.equal(
    detectDemand(clusters(10, 30), MIX).signals.length,
    0,
    "a quarter singletons is healthy",
  );
});

test("cooccurring_intents is never emitted in Phase 1", () => {
  assert.ok(
    detectDemand(clusters(209, 23), MIX).signals.every((s) => s.kind !== "cooccurring_intents"),
  );
});
