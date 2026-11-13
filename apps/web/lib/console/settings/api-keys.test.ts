import assert from "node:assert/strict";
import { test } from "node:test";
import {
  API_KEY_STATUS,
  apiKeyDisplayName,
  apiKeyRow,
  newKeyCloseDecision,
} from "@/lib/console/settings/api-keys";
import type { ApiKeySummary } from "@/lib/platform/api-key-actions";

const NOW = new Date("2026-10-18T12:00:00.000Z");

function key(overrides: Partial<ApiKeySummary> = {}): ApiKeySummary {
  return {
    id: "k1",
    name: "Staging",
    keyPrefix: "rtl_a1b2c3d4",
    createdAt: "2026-10-15T09:00:00.000Z",
    lastUsedAt: "2026-10-18T11:55:00.000Z",
    expiresAt: "2026-10-22T09:00:00.000Z",
    status: "active",
    ...overrides,
  };
}

test("a key's row says everything in words and never carries a secret", () => {
  const row = apiKeyRow(key(), NOW);
  assert.deepEqual(row, {
    id: "k1",
    name: "Staging",
    named: true,
    label: "Staging",
    prefix: "rtl_a1b2c3d4",
    created: "Oct 15, 2026",
    createdTitle: "Oct 15, 2026, 09:00:00 UTC",
    lastUsed: "5m ago",
    lastUsedTitle: "Oct 18, 2026, 11:55:00 UTC",
    expires: "Oct 22, 2026",
    status: { tone: "success", label: "Active" },
  });
});

test("an unnamed, unused, permanent key reads as such", () => {
  const row = apiKeyRow(key({ name: null, lastUsedAt: null, expiresAt: null }), NOW);
  assert.equal(row.name, "Unnamed key");
  assert.equal(row.named, false);
  assert.equal(row.label, "rtl_a1b2c3d4…", "buttons and dialogs name it by its prefix");
  assert.equal(row.lastUsed, "Never");
  assert.equal(row.lastUsedTitle, null);
  assert.equal(row.expires, "Never");
});

test("status is a word with its tone, never color alone", () => {
  assert.deepEqual(API_KEY_STATUS.expired, { tone: "warning", label: "Expired" });
  assert.deepEqual(API_KEY_STATUS.revoked, { tone: "neutral", label: "Revoked" });
  assert.equal(apiKeyRow(key({ status: "expired" }), NOW).status.label, "Expired");
});

test("a dialog names a key by its name, or its prefix when it has none", () => {
  assert.equal(apiKeyDisplayName({ name: "CI", keyPrefix: "rtl_x" }), "CI");
  assert.equal(apiKeyDisplayName({ name: null, keyPrefix: "rtl_x" }), "rtl_x…");
});

test("a new key's dialog asks once before it lets go of an uncopied key", () => {
  assert.equal(newKeyCloseDecision({ copied: false, asking: false }), "ask");
  assert.equal(
    newKeyCloseDecision({ copied: false, asking: true }),
    "close",
    "asked already: the second close is meant",
  );
  assert.equal(newKeyCloseDecision({ copied: true, asking: false }), "close");
});
