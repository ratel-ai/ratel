import assert from "node:assert/strict";
import { test } from "node:test";
import { signWebhookBody, verifyWebhookSignature } from "./webhook-signature";

const SECRET = "test-webhook-secret";
const BODY = JSON.stringify({ action: "deleted", installation: { id: 42 } });

test("accepts the correct HMAC", () => {
  assert.equal(verifyWebhookSignature(BODY, signWebhookBody(BODY, SECRET), SECRET), true);
});

test("accepts a Uint8Array body", () => {
  const bytes = new TextEncoder().encode(BODY);
  assert.equal(verifyWebhookSignature(bytes, signWebhookBody(BODY, SECRET), SECRET), true);
});

test("rejects a signature made with another secret", () => {
  assert.equal(verifyWebhookSignature(BODY, signWebhookBody(BODY, "other"), SECRET), false);
});

test("rejects a signature of another body", () => {
  assert.equal(verifyWebhookSignature(BODY, signWebhookBody(`${BODY} `, SECRET), SECRET), false);
});

test("rejects a missing, empty, unprefixed or truncated signature", () => {
  const good = signWebhookBody(BODY, SECRET);
  for (const signature of [
    null,
    undefined,
    "",
    good.slice("sha256=".length),
    good.slice(0, -2),
    "sha256=zz",
  ]) {
    assert.equal(verifyWebhookSignature(BODY, signature, SECRET), false, String(signature));
  }
});

test("rejects everything when no secret is configured", () => {
  assert.equal(verifyWebhookSignature(BODY, signWebhookBody(BODY, ""), ""), false);
});
