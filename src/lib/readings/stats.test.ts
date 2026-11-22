import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFIDENT_SCORE_RATIO, wilsonInterval } from "./stats";

test("the Wilson interval stays inside [0, 1] and narrows with the sample", () => {
  assert.equal(wilsonInterval(3, 0), null);
  const small = wilsonInterval(5, 10);
  const large = wilsonInterval(500, 1000);
  assert.ok(small && large);
  assert.ok(small.low >= 0 && small.high <= 1);
  assert.ok(large.high - large.low < small.high - small.low);
  // Known values: 7 of 10 at z = 1.96.
  const seven = wilsonInterval(7, 10);
  assert.ok(seven);
  assert.equal(seven.low.toFixed(4), "0.3968");
  assert.equal(seven.high.toFixed(4), "0.8922");
  // The extremes are pulled in, never past the bounds.
  const all = wilsonInterval(10, 10);
  assert.ok(all && all.high === 1 && all.low > 0.65);
  const none = wilsonInterval(0, 10);
  assert.ok(none && none.low === 0 && none.high < 0.35);
});

test("the confident-score ratio is the cut the companion panels read", () => {
  assert.equal(CONFIDENT_SCORE_RATIO, 0.9);
});
