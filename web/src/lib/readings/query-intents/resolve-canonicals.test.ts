import assert from "node:assert/strict";
import { test } from "node:test";
import { Bm25Clusterer } from "@/lib/readings/query-intents/bm25-clusterer";
import { jaccardClusterer } from "@/lib/readings/query-intents/clusterer";
import { normalizeIntent } from "@/lib/readings/query-intents/normalize";
import {
  type ResolveCanonicalsDeps,
  resolveCanonicals,
} from "@/lib/readings/query-intents/resolve-canonicals";

const cand = (text: string) => ({ key: normalizeIntent(text), text });

test("exact matches never reach the clusterer; the rest are clustered against the seeds", async () => {
  const calls: string[] = [];
  const deps: ResolveCanonicalsDeps = {
    lookupExactCanonicals: async (_p, keys) => {
      calls.push(`exact:${keys.length}`);
      return keys
        .filter((k) => k === "refund their order")
        .map((k) => ({ id: "ex1", normalizedText: k, text: "Refund their order" }));
    },
    listExistingCanonicals: async () => {
      calls.push("seeds");
      return [
        {
          id: "ex1",
          normalizedText: "refund their order",
          text: "Refund their order",
          memberText: "",
        },
      ];
    },
    clusterer: new Bm25Clusterer(),
  };
  const out = await resolveCanonicals(
    "p",
    [
      cand("Refund their order."),
      cand("refund their order please"),
      cand("write unit tests"),
      cand("Refund their order."),
    ],
    deps,
  );
  assert.deepEqual(calls, ["exact:3", "seeds"], "deduped by key; seeds fetched once");
  assert.equal(out.size, 3);
  assert.equal(out.get("refund their order")!.canonicalText, "Refund their order");
  assert.equal(
    out.get("refund their order please")!.canonicalText,
    "Refund their order",
    "clustered into the seed",
  );
  assert.equal(out.get("write unit tests")!.canonicalText, "write unit tests", "stands alone");
});

test("seeds are not fetched when everything matched exactly", async () => {
  let seedCalls = 0;
  const out = await resolveCanonicals("p", [cand("a b c")], {
    lookupExactCanonicals: async () => [{ id: "x", normalizedText: "a b c", text: "a b c" }],
    listExistingCanonicals: async () => {
      seedCalls++;
      return [];
    },
    clusterer: jaccardClusterer,
  });
  assert.equal(seedCalls, 0);
  assert.equal(out.get("a b c")!.canonicalText, "a b c");
});

test("empty input is an empty map with no lookups", async () => {
  const out = await resolveCanonicals("p", [], {
    lookupExactCanonicals: async () => {
      throw new Error("must not be called");
    },
    listExistingCanonicals: async () => {
      throw new Error("must not be called");
    },
    clusterer: jaccardClusterer,
  });
  assert.equal(out.size, 0);
});
