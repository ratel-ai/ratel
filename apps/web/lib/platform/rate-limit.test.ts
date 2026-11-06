import assert from "node:assert/strict";
import { test } from "node:test";
import { createTokenBucketRateLimiter } from "@/lib/platform/rate-limit";

test("token bucket allows the burst, then reports when one token is available", () => {
  let now = 0;
  const limiter = createTokenBucketRateLimiter({
    limitPerMinute: 120,
    burst: 240,
    now: () => now,
  });

  for (let request = 0; request < 240; request += 1) {
    assert.deepEqual(limiter.consume("key-1"), { allowed: true });
  }
  assert.deepEqual(limiter.consume("key-1"), {
    allowed: false,
    retryAfterSeconds: 1,
  });

  now = 500;
  assert.deepEqual(limiter.consume("key-1"), { allowed: true });
});

test("token buckets are independent per API key", () => {
  const limiter = createTokenBucketRateLimiter({
    limitPerMinute: 1,
    burst: 1,
    now: () => 0,
  });

  assert.deepEqual(limiter.consume("key-1"), { allowed: true });
  assert.deepEqual(limiter.consume("key-1"), {
    allowed: false,
    retryAfterSeconds: 60,
  });
  assert.deepEqual(limiter.consume("key-2"), { allowed: true });
});

test("token bucket evicts full idle keys after crossing the sweep threshold", () => {
  let now = 0;
  const limiter = createTokenBucketRateLimiter({
    limitPerMinute: 60,
    burst: 1,
    now: () => now,
    sweepThreshold: 2,
  });

  assert.deepEqual(limiter.consume("idle-key"), { allowed: true });
  assert.deepEqual(limiter.consume("active-key"), { allowed: true });
  now = 1_000;
  assert.deepEqual(limiter.consume("active-key"), { allowed: true });

  assert.deepEqual(limiter.consume("new-key"), { allowed: true });
  assert.equal(limiter.bucketCount, 2);
  assert.deepEqual(limiter.consume("active-key"), {
    allowed: false,
    retryAfterSeconds: 1,
  });
});

test("peek reports availability without spending a token", () => {
  const limiter = createTokenBucketRateLimiter({
    limitPerMinute: 60,
    burst: 2,
    now: () => 0,
  });

  // Asking must be free, and asking about a key nobody has used must not
  // record one: a budget charged on inspection would drain itself.
  assert.deepEqual(limiter.peek("key-1"), { allowed: true });
  assert.deepEqual(limiter.peek("key-1"), { allowed: true });
  assert.equal(limiter.bucketCount, 0);

  limiter.consume("key-1");
  limiter.consume("key-1");

  assert.deepEqual(limiter.peek("key-1"), { allowed: false, retryAfterSeconds: 1 });
});
