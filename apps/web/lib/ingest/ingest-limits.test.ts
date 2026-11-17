import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createPublishableIngestLimits,
  DEFAULT_PUBLISHABLE_KEY_LIMIT_PER_MINUTE,
  ingestRateLimitedResponse,
  publishableLimitOptionsFromEnv,
  sourceBucket,
} from "@/lib/ingest/ingest-limits";

function from(address: string): Request {
  return new Request("https://cloud.ratel.sh/v1/traces", {
    method: "POST",
    // The ALB appends the real peer last; the leading hops are caller-supplied.
    headers: { "x-forwarded-for": `203.0.113.99, ${address}` },
  });
}

const KEY = { id: "key-1", rateLimitPerMinute: null };

test("one source is held to its own share and told when to retry", () => {
  const limits = createPublishableIngestLimits({
    perKeyPerMinute: 1_000,
    perSourcePerMinute: 2,
    now: () => 0,
  });
  // Burst is twice the per-minute rate.
  for (let i = 0; i < 4; i += 1)
    assert.ok(limits.check(from("10.0.0.1"), KEY).allowed, `request ${i}`);
  const denied = limits.check(from("10.0.0.1"), KEY);
  assert.ok(!denied.allowed);
  assert.equal(denied.limit, "per_source");
  assert.ok(denied.retryAfterSeconds >= 1);
  // Another install sharing the key is unaffected.
  assert.ok(limits.check(from("10.0.0.2"), KEY).allowed);
});

test("a forged leading X-Forwarded-For hop does not buy a fresh budget", () => {
  const limits = createPublishableIngestLimits({
    perKeyPerMinute: 1_000,
    perSourcePerMinute: 1,
    now: () => 0,
  });
  const forged = (fake: string) =>
    new Request("https://cloud.ratel.sh/v1/traces", {
      headers: { "x-forwarded-for": `${fake}, 10.0.0.1` },
    });
  assert.ok(limits.check(forged("1.1.1.1"), KEY).allowed);
  assert.ok(limits.check(forged("2.2.2.2"), KEY).allowed);
  assert.equal(limits.check(forged("3.3.3.3"), KEY).allowed, false);
});

test("the whole fleet shares one per-key ceiling", () => {
  const limits = createPublishableIngestLimits({
    perKeyPerMinute: 2,
    perSourcePerMinute: 100,
    now: () => 0,
  });
  for (let i = 0; i < 4; i += 1) assert.ok(limits.check(from(`10.0.1.${i}`), KEY).allowed);
  const denied = limits.check(from("10.0.1.200"), KEY);
  assert.ok(!denied.allowed);
  assert.equal(denied.limit, "per_key");
});

test("a key's own ceiling overrides the default, and other keys keep theirs", () => {
  const limits = createPublishableIngestLimits({
    perKeyPerMinute: 1,
    perSourcePerMinute: 100,
    now: () => 0,
  });
  const raised = { id: "key-raised", rateLimitPerMinute: 5 };
  for (let i = 0; i < 10; i += 1)
    assert.ok(limits.check(from(`10.0.2.${i}`), raised).allowed, `request ${i}`);
  assert.equal(limits.check(from("10.0.2.99"), raised).allowed, false);
  assert.ok(limits.check(from("10.0.2.1"), { id: "key-other", rateLimitPerMinute: null }).allowed);
});

test("a source over its share does not spend the fleet's budget", () => {
  const limits = createPublishableIngestLimits({
    perKeyPerMinute: 2,
    perSourcePerMinute: 1,
    now: () => 0,
  });
  limits.check(from("10.0.3.1"), KEY);
  limits.check(from("10.0.3.1"), KEY);
  for (let i = 0; i < 20; i += 1) limits.check(from("10.0.3.1"), KEY);
  // Two tokens spent of four; another address still gets through.
  assert.ok(limits.check(from("10.0.3.2"), KEY).allowed);
});

test("the default ceiling is far above a secret key's 120 a minute, and env can set both", () => {
  assert.ok(DEFAULT_PUBLISHABLE_KEY_LIMIT_PER_MINUTE > 120);
  assert.deepEqual(
    publishableLimitOptionsFromEnv({
      RATEL_PUBLISHABLE_KEY_LIMIT_PER_MINUTE: "20000",
      RATEL_PUBLISHABLE_SOURCE_LIMIT_PER_MINUTE: "30",
    }),
    {
      perKeyPerMinute: 20_000,
      perSourcePerMinute: 30,
      perKeyItemsPerMinute: 200_000,
      perSourceItemsPerMinute: 300,
    },
  );
  assert.equal(
    publishableLimitOptionsFromEnv({ RATEL_PUBLISHABLE_KEY_LIMIT_PER_MINUTE: "-1" })
      .perKeyPerMinute,
    DEFAULT_PUBLISHABLE_KEY_LIMIT_PER_MINUTE,
  );
});

test("a refusal is a 429 with Retry-After", async () => {
  const response = ingestRateLimitedResponse({
    allowed: false,
    retryAfterSeconds: 7,
    limit: "per_source",
  });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "7");
  assert.equal((await response.json()).reason, "per_source");
});

test("items are charged too: one big batch cannot slip under a request budget", () => {
  const limits = createPublishableIngestLimits({
    perKeyPerMinute: 1_000,
    perSourcePerMinute: 100,
    perSourceItemsPerMinute: 50,
    now: () => 0,
  });
  // Burst is 100 items for this source.
  assert.ok(limits.check(from("10.0.4.1"), KEY).allowed);
  assert.ok(limits.chargeItems(from("10.0.4.1"), KEY, 80).allowed);
  const denied = limits.chargeItems(from("10.0.4.1"), KEY, 80);
  assert.ok(!denied.allowed);
  assert.equal(denied.limit, "per_source");
  assert.ok(limits.chargeItems(from("10.0.4.2"), KEY, 80).allowed, "another install is unaffected");
});

test("the fleet's item ceiling follows a key's own ceiling", () => {
  const limits = createPublishableIngestLimits({
    perKeyPerMinute: 1,
    perSourcePerMinute: 1_000,
    now: () => 0,
  });
  const raised = { id: "key-items", rateLimitPerMinute: 10 };
  // 10 requests a minute => 100 items a minute, burst 200.
  assert.ok(limits.chargeItems(from("10.0.5.1"), raised, 150).allowed);
  assert.ok(!limits.chargeItems(from("10.0.5.2"), raised, 100).allowed);
});

test("an IPv6 source is one bucket per /64", () => {
  assert.equal(sourceBucket("2001:db8:abcd:12:aaaa::1"), "2001:db8:abcd:12::/64");
  assert.equal(sourceBucket("2001:db8:abcd:12:ffff:ffff:ffff:ffff"), "2001:db8:abcd:12::/64");
  assert.equal(sourceBucket("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(sourceBucket("203.0.113.7"), "203.0.113.7");

  const limits = createPublishableIngestLimits({
    perKeyPerMinute: 1_000,
    perSourcePerMinute: 1,
    now: () => 0,
  });
  assert.ok(limits.check(from("2001:db8:abcd:12::1"), KEY).allowed);
  assert.ok(limits.check(from("2001:db8:abcd:12::2"), KEY).allowed);
  assert.equal(
    limits.check(from("2001:db8:abcd:12::3"), KEY).allowed,
    false,
    "rotating inside the /64 buys nothing",
  );
  assert.ok(limits.check(from("2001:db8:abcd:13::1"), KEY).allowed);
});
