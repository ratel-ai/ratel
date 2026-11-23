import assert from "node:assert/strict";
import { test } from "node:test";
import { createFixedWindowQuota } from "./quota";

function clock(start = 1_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

test("a quota allows up to the limit and then refuses", () => {
  const quota = createFixedWindowQuota(2, 1_000, clock().now);
  assert.deepEqual([quota.consume("u").allowed, quota.consume("u").allowed], [true, true]);
  const refused = quota.consume("u");
  assert.equal(refused.allowed, false);
  assert.equal(refused.remaining, 0);
});

test("remaining counts down with each allowed call", () => {
  const quota = createFixedWindowQuota(3, 1_000, clock().now);
  assert.equal(quota.consume("u").remaining, 2);
  assert.equal(quota.consume("u").remaining, 1);
  assert.equal(quota.consume("u").remaining, 0);
});

test("keys are counted independently", () => {
  const quota = createFixedWindowQuota(1, 1_000, clock().now);
  assert.equal(quota.consume("a").allowed, true);
  assert.equal(quota.consume("b").allowed, true);
  assert.equal(quota.consume("a").allowed, false);
});

test("the window reopens once it elapses", () => {
  const time = clock();
  const quota = createFixedWindowQuota(1, 1_000, time.now);
  assert.equal(quota.consume("u").allowed, true);
  assert.equal(quota.consume("u").allowed, false);

  time.advance(999);
  assert.equal(quota.consume("u").allowed, false);
  time.advance(2);
  assert.equal(quota.consume("u").allowed, true);
});

test("a refused call does not consume budget", () => {
  const quota = createFixedWindowQuota(2, 1_000, clock().now);
  quota.consume("u", 2);
  // Over-budget at cost 2, but a cost-1 call still fits nothing: the refusal
  // must not have incremented the counter past the limit either.
  assert.equal(quota.consume("u", 1).allowed, false);
  assert.equal(quota.consume("u", 1).remaining, 0);
});

test("a cost larger than the whole limit is refused outright", () => {
  const quota = createFixedWindowQuota(2, 1_000, clock().now);
  assert.equal(quota.consume("u", 5).allowed, false);
  // …and leaves the window usable for calls that do fit.
  assert.equal(quota.consume("u", 2).allowed, true);
});
