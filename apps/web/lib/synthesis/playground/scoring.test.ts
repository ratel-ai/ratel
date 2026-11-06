import assert from "node:assert/strict";
import { test } from "node:test";
import {
  blendScores,
  clampHybridShare,
  clampWeight,
  cosineSimilarity,
  HYBRID_MAX_SHARE,
  HYBRID_MIN_SHARE,
  normalizeWithinBucket,
  rankIds,
} from "./scoring";

test("cosineSimilarity handles identical, orthogonal, and degenerate vectors", () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1);
  // A zero vector has no direction, so similarity is 0 rather than NaN.
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
  // Mismatched lengths cannot be compared at all.
  assert.equal(cosineSimilarity([1, 2, 3], [1, 2]), 0);
  assert.equal(cosineSimilarity([], []), 0);
});

test("cosineSimilarity is scale invariant", () => {
  const a = cosineSimilarity([1, 2, 3], [2, 4, 6]);
  assert.ok(Math.abs(a - 1) < 1e-9);
});

test("normalizeWithinBucket maps a bucket onto [0, 1] by its own extremes", () => {
  const normalized = normalizeWithinBucket(
    new Map([
      ["a", 4],
      ["b", 2],
      ["c", 0],
    ]),
  );
  assert.equal(normalized.get("a"), 1);
  assert.equal(normalized.get("b"), 0.5);
  assert.equal(normalized.get("c"), 0);
});

test("normalizeWithinBucket maps an all-equal bucket to 0, not 1", () => {
  // "Everything tied" must not read as "everything is a perfect match", which
  // would let a bucket where nothing matched dominate a hybrid blend.
  const tied = normalizeWithinBucket(
    new Map([
      ["a", 0],
      ["b", 0],
    ]),
  );
  assert.deepEqual([...tied.values()], [0, 0]);

  const alsoTied = normalizeWithinBucket(
    new Map([
      ["a", 7],
      ["b", 7],
    ]),
  );
  assert.deepEqual([...alsoTied.values()], [0, 0]);
});

test("normalizeWithinBucket returns an empty map for an empty bucket", () => {
  assert.equal(normalizeWithinBucket(new Map()).size, 0);
});

test("clampWeight bounds the blend and rejects non-finite input", () => {
  assert.equal(clampWeight(0.4), 0.4);
  assert.equal(clampWeight(-1), 0);
  assert.equal(clampWeight(2), 1);
  assert.equal(clampWeight(Number.NaN), 0);
});

test("blendScores reproduces each pure side at the weight endpoints", () => {
  const lexical = new Map([
    ["a", 1],
    ["b", 0],
  ]);
  const semantic = new Map([
    ["a", 0],
    ["b", 1],
  ]);
  assert.deepEqual([...blendScores(lexical, semantic, 0)], [...lexical]);
  assert.deepEqual([...blendScores(lexical, semantic, 1)], [...semantic]);
});

test("blendScores treats an id missing from one side as a zero there", () => {
  const blended = blendScores(new Map([["a", 1]]), new Map([["b", 1]]), 0.5);
  assert.equal(blended.get("a"), 0.5);
  assert.equal(blended.get("b"), 0.5);
});

test("rankIds orders by score and breaks ties deterministically", () => {
  assert.deepEqual(
    rankIds(
      new Map([
        ["b", 1],
        ["a", 1],
        ["c", 3],
      ]),
    ),
    ["c", "a", "b"],
  );
});

test("the hybrid band stops short of the pure modes", () => {
  // 0% is exactly Embeddings and 100% is exactly BM25, and both already have a
  // button. Offering them again on the mix slider is two ways to reach a place
  // you can already get to, sitting where a reader expects a blend.
  assert.ok(HYBRID_MIN_SHARE > 0);
  assert.ok(HYBRID_MAX_SHARE < 100);
  assert.equal(clampHybridShare(0), HYBRID_MIN_SHARE);
  assert.equal(clampHybridShare(100), HYBRID_MAX_SHARE);
  assert.equal(clampHybridShare(-40), HYBRID_MIN_SHARE);
  assert.equal(clampHybridShare(140), HYBRID_MAX_SHARE);
});

test("a share already inside the band is left alone", () => {
  assert.equal(clampHybridShare(50), 50);
  assert.equal(clampHybridShare(HYBRID_MIN_SHARE), HYBRID_MIN_SHARE);
  assert.equal(clampHybridShare(HYBRID_MAX_SHARE), HYBRID_MAX_SHARE);
});

test("a non-finite share falls back to an even split, not to an edge", () => {
  assert.equal(clampHybridShare(Number.NaN), 50);
});

test("blendScores still honours the pure ends the slider no longer offers", () => {
  // The band is what the CONTROL offers; the maths keeps working at 0 and 1, and
  // the route keeps accepting them.
  const lexical = new Map([["a", 1]]);
  const semantic = new Map([["a", 0]]);
  assert.equal(blendScores(lexical, semantic, 0).get("a"), 1);
  assert.equal(blendScores(lexical, semantic, 1).get("a"), 0);
});
