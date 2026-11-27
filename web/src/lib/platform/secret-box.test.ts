import assert from "node:assert/strict";
import { test } from "node:test";
import { openSecret, SecretBoxError, sealSecret, secretBoxConfigured } from "./secret-box";

const KEY = "k".repeat(64);
const SECRET = "https://hooks.slack.com/services/T0/B0/abcd";

test("what is sealed for a row opens for that row, and nothing is in the clear", () => {
  const sealed = sealSecret(SECRET, "row-1", KEY);
  assert.equal(openSecret(sealed, "row-1", KEY), SECRET);
  assert.doesNotMatch(Buffer.from(sealed.slice(3), "base64url").toString("latin1"), /slack/);
  assert.notEqual(sealSecret(SECRET, "row-1", KEY), sealed);
});

test("another row, another key, a changed byte or no key does not open", () => {
  const sealed = sealSecret(SECRET, "row-1", KEY);
  const flipped = sealed.slice(0, -2) + (sealed.endsWith("AA") ? "BB" : "AA");
  for (const open of [
    () => openSecret(sealed, "row-2", KEY),
    () => openSecret(sealed, "row-1", "x".repeat(64)),
    () => openSecret(flipped, "row-1", KEY),
    () => openSecret("v1.", "row-1", KEY),
    () => openSecret("nonsense", "row-1", KEY),
    () => openSecret(sealed, "row-1", ""),
    () => sealSecret(SECRET, "row-1", ""),
  ])
    assert.throws(
      open,
      (error: Error) => error instanceof SecretBoxError && !error.message.includes("slack"),
    );
  assert.equal(secretBoxConfigured(""), false);
  assert.equal(secretBoxConfigured(KEY), true);
});
