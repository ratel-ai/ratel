import assert from "node:assert/strict";
import { test } from "node:test";
import {
  API_KEY_EXPIRY_CHOICES,
  API_KEY_NAME_MAX_LEN,
  apiKeyStatus,
  generateApiKey,
  hashApiKey,
  isApiKeyExpired,
  normalizeApiKeyName,
  resolveApiKeyExpiry,
} from "@/lib/platform/api-keys";

const NOW = new Date("2026-08-10T12:00:00.000Z");

test("generated keys carry a recognizable prefix and a matching hash", () => {
  const key = generateApiKey();

  assert.ok(key.plaintext.startsWith("rtl_"));
  assert.ok(key.plaintext.startsWith(key.prefix));
  assert.equal(key.hash, hashApiKey(key.plaintext));
  assert.notEqual(key.plaintext, generateApiKey().plaintext);
});

/* — Status ———————————————————————————————————————————————————————————————— */

test("a key with no expiry is active forever", () => {
  const key = { revokedAt: null, expiresAt: null };

  assert.equal(isApiKeyExpired(key, NOW), false);
  assert.equal(apiKeyStatus(key, NOW), "active");
  assert.equal(apiKeyStatus(key, new Date("2099-01-01T00:00:00.000Z")), "active");
});

test("a key expires the instant its expiry passes", () => {
  const key = { revokedAt: null, expiresAt: NOW };

  assert.equal(isApiKeyExpired({ ...key }, new Date(NOW.getTime() - 1)), false);
  // Exactly at the boundary the key is spent — expiry is exclusive.
  assert.equal(isApiKeyExpired({ ...key }, NOW), true);
  assert.equal(apiKeyStatus({ ...key }, new Date(NOW.getTime() + 1)), "expired");
});

test("revocation outranks expiry so a revoked key never reads as merely expired", () => {
  const revokedAt = new Date("2026-08-01T00:00:00.000Z");

  assert.equal(apiKeyStatus({ revokedAt, expiresAt: null }, NOW), "revoked");
  assert.equal(apiKeyStatus({ revokedAt, expiresAt: NOW }, NOW), "revoked");
});

/* — Name ——————————————————————————————————————————————————————————————————— */

test("a name is optional and blank input stores nothing", () => {
  assert.deepEqual(normalizeApiKeyName(undefined), { ok: true, name: null });
  assert.deepEqual(normalizeApiKeyName(null), { ok: true, name: null });
  assert.deepEqual(normalizeApiKeyName("   "), { ok: true, name: null });
});

test("a name is trimmed and length-capped", () => {
  assert.deepEqual(normalizeApiKeyName("  Staging  "), { ok: true, name: "Staging" });

  const tooLong = normalizeApiKeyName("x".repeat(API_KEY_NAME_MAX_LEN + 1));
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.ok === false ? tooLong.error : "", /64 characters or fewer/);
});

/* — Expiration presets ———————————————————————————————————————————————————— */

test("the dropdown offers durations shortest-first with never last", () => {
  assert.deepEqual(
    API_KEY_EXPIRY_CHOICES.map((c) => c.value),
    ["1w", "1mo", "3mo", "6mo", "12mo", "2y", "never"],
  );
  assert.deepEqual(
    API_KEY_EXPIRY_CHOICES.map((c) => c.label),
    ["1 week", "1 month", "3 months", "6 months", "12 months", "2 years", "Never"],
  );
});

test("never resolves to no expiry", () => {
  assert.deepEqual(resolveApiKeyExpiry("never", NOW), { ok: true, expiresAt: null });
  // Omitted is the same as explicitly choosing never.
  assert.deepEqual(resolveApiKeyExpiry(undefined, NOW), { ok: true, expiresAt: null });
});

test("each preset resolves to the matching instant from now", () => {
  const resolved = (preset: Parameters<typeof resolveApiKeyExpiry>[0]) => {
    const result = resolveApiKeyExpiry(preset, NOW);
    return result.ok === true ? result.expiresAt?.toISOString() : `error`;
  };

  assert.equal(resolved("1w"), "2026-08-17T12:00:00.000Z");
  assert.equal(resolved("1mo"), "2026-09-10T12:00:00.000Z");
  assert.equal(resolved("3mo"), "2026-11-10T12:00:00.000Z");
  assert.equal(resolved("6mo"), "2027-02-10T12:00:00.000Z");
  assert.equal(resolved("12mo"), "2027-08-10T12:00:00.000Z");
  assert.equal(resolved("2y"), "2028-08-10T12:00:00.000Z");
});

test("a month-preset clamps rather than rolling into the next month", () => {
  // Aug 31 + 6 months is Feb 31, which must land on Feb 28 (2027 is not a leap year)
  // instead of spilling over to March 3.
  const result = resolveApiKeyExpiry("6mo", new Date("2026-08-31T12:00:00.000Z"));

  assert.equal(
    result.ok === true ? result.expiresAt?.toISOString() : null,
    "2027-02-28T12:00:00.000Z",
  );
});

test("a month-preset lands on Feb 29 in a leap year", () => {
  const result = resolveApiKeyExpiry("12mo", new Date("2027-02-28T12:00:00.000Z"));

  assert.equal(
    result.ok === true ? result.expiresAt?.toISOString() : null,
    "2028-02-28T12:00:00.000Z",
  );
});

test("a preset outside the offered set is rejected", () => {
  const result = resolveApiKeyExpiry("99y" as never, NOW);

  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.error : "", /expiration/i);
});
