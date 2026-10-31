import assert from "node:assert/strict";
import { test } from "node:test";
import { scoreClustering } from "@/lib/readings/intent-engine/eval";

test("perfect clustering scores 1 everywhere", () => {
  const s = scoreClustering(["a", "a", "b"], ["x", "x", "y"]);
  assert.deepEqual([s.purity, s.inversePurity, s.precision, s.recall, s.f1], [1, 1, 1, 1, 1]);
});

test("over-splitting keeps precision, loses recall; over-merging the reverse", () => {
  const split = scoreClustering(["a", "b", "c"], ["x", "x", "x"]);
  assert.equal(split.precision, 1);
  assert.equal(split.recall, 0);
  const merged = scoreClustering(["a", "a", "a", "a"], ["x", "x", "y", "y"]);
  assert.equal(merged.recall, 1);
  assert.equal(merged.precision, 2 / 6);
  assert.equal(merged.purity, 0.5);
});
