import assert from "node:assert/strict";
import { test } from "node:test";
import { type ApiKeyCtaRecord, apiKeyCta, noApiKeyCta } from "@/lib/console/api-key-cta";
import { TRACES_DOCS } from "@/lib/console/docs-links";

const NOW = new Date("2026-11-26T12:00:00Z");

function key(overrides: Partial<ApiKeyCtaRecord> = {}): ApiKeyCtaRecord {
  return {
    name: "Onboarding",
    keyPrefix: "rtl_a1b2c3d4",
    createdAt: new Date("2026-11-20T09:30:00Z"),
    revokedAt: null,
    expiresAt: null,
    scopes: ["*"],
    ...overrides,
  };
}

test("no key: the CTA creates one, and creating it is the next step", () => {
  const cta = apiKeyCta("proj 1", [], NOW);
  assert.equal(cta.kind, "create");
  assert.equal(cta.label, "Create an API key");
  assert.equal(cta.href, "/project/proj%201/settings/api-keys");
  assert.equal(cta.key, null);
  assert.equal(cta.next.label, "Create an API key");
  assert.equal(cta.next.href, cta.href);
});

test("an active key: the CTA views it, and the next step is the first trace", () => {
  const cta = apiKeyCta("p1", [key()], NOW);
  assert.equal(cta.kind, "view");
  assert.equal(cta.label, "View API keys");
  assert.equal(cta.href, "/project/p1/settings/api-keys");
  assert.deepEqual(cta.key, {
    name: "Onboarding",
    keyPrefix: "rtl_a1b2c3d4",
    createdAt: "2026-11-20T09:30:00.000Z",
    detail: "Onboarding · rtl_a1b2c3d4… · created Nov 20, 2026",
  });
  assert.equal(cta.next.label, "Send your first trace");
  assert.equal(cta.next.href, TRACES_DOCS);
});

test("revoked and expired keys do not count as having one", () => {
  const cta = apiKeyCta(
    "p1",
    [
      key({ revokedAt: new Date("2026-11-21T00:00:00Z") }),
      key({ expiresAt: new Date("2026-11-26T12:00:00Z") }),
    ],
    NOW,
  );
  assert.equal(cta.kind, "create");
});

test("a key that expires later still counts", () => {
  const cta = apiKeyCta("p1", [key({ expiresAt: new Date("2026-12-26T00:00:00Z") })], NOW);
  assert.equal(cta.kind, "view");
});

test("the key shown is the one the snippets use: Full before scoped, then newest", () => {
  const cta = apiKeyCta(
    "p1",
    [
      key({ name: "Old full", createdAt: new Date("2026-10-01T00:00:00Z") }),
      key({ name: "Newer full", createdAt: new Date("2026-11-01T00:00:00Z") }),
      key({
        name: "Ingest only",
        keyPrefix: "rtl_pub_zz",
        scopes: ["traces:write"],
        createdAt: new Date("2026-11-25T00:00:00Z"),
      }),
    ],
    NOW,
  );
  assert.equal(cta.key?.name, "Newer full");
});

test("an unnamed key is described by its prefix and date alone", () => {
  const cta = apiKeyCta("p1", [key({ name: null })], NOW);
  assert.equal(cta.key?.detail, "rtl_a1b2c3d4… · created Nov 20, 2026");
});

test("the created date is the UTC day, whatever the server's zone", () => {
  const cta = apiKeyCta("p1", [key({ createdAt: new Date("2026-11-20T23:59:00Z") })], NOW);
  assert.match(cta.key?.detail ?? "", /created Nov 20, 2026$/);
});

test("the fallback for a failed read is the create CTA", () => {
  const cta = noApiKeyCta("p1");
  assert.deepEqual(cta, apiKeyCta("p1", [], NOW));
});
