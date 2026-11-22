import assert from "node:assert/strict";
import { test } from "node:test";
import { CALL_BUCKETS, callBucket, countryCalls } from "./country-map-model";

test("no calls is bucket 0, the neutral fill", () => {
  assert.equal(callBucket(0, 100), 0);
  assert.equal(callBucket(5, 0), 0);
  assert.equal(callBucket(-1, 10), 0);
});

test("buckets grow on a log scale: one call is the lightest, the busiest country the darkest", () => {
  assert.equal(CALL_BUCKETS, 4);
  assert.equal(callBucket(1, 10_000), 1);
  assert.equal(callBucket(10, 10_000), 2);
  assert.equal(callBucket(100, 10_000), 3);
  assert.equal(callBucket(1_000, 10_000), 4);
  assert.equal(callBucket(10_000, 10_000), 4);
});

test("a single busy country and a single call each take the darkest bucket", () => {
  assert.equal(callBucket(1, 1), CALL_BUCKETS);
  assert.equal(callBucket(42, 42), CALL_BUCKETS);
  assert.equal(callBucket(1, 2), 1);
  assert.equal(callBucket(2, 2), CALL_BUCKETS);
});

test("countryCalls joins rows by canonical code, skips the unknown row and sums aliases", () => {
  const calls = countryCalls([
    { country: "it", calls: 3, sessions: 2 },
    { country: null, calls: 9, sessions: 4 },
    { country: "GB", calls: 2, sessions: 1 },
    { country: "UK", calls: 1, sessions: 1 },
  ]);
  assert.deepEqual(
    [...calls.entries()],
    [
      ["IT", { code: "IT", calls: 3, sessions: 2 }],
      ["GB", { code: "GB", calls: 3, sessions: 2 }],
    ],
  );
});
