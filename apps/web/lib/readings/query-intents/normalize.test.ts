import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeIntent } from "@/lib/readings/query-intents/normalize";

test("lowercases, trims, and collapses internal whitespace", () => {
  assert.equal(normalizeIntent("  Deploy   the\nAPI  "), "deploy the api");
});

test("strips trailing sentence punctuation", () => {
  assert.equal(normalizeIntent("Run the tests."), "run the tests");
  assert.equal(normalizeIntent("Run the tests!!!"), "run the tests");
  assert.equal(normalizeIntent("really??"), "really");
});

test("folds case / spacing / trailing-punctuation variants to the same key", () => {
  assert.equal(
    normalizeIntent("Set up a P95 latency alert"),
    normalizeIntent("set up a p95   latency alert."),
  );
});

test("keeps internal punctuation that carries meaning", () => {
  assert.equal(normalizeIntent("export it as a .png file"), "export it as a .png file");
  assert.equal(
    normalizeIntent("scaffold a REST endpoint, with a test"),
    "scaffold a rest endpoint, with a test",
  );
});

test("is idempotent", () => {
  const once = normalizeIntent("  Generate THE migrations!  ");
  assert.equal(normalizeIntent(once), once);
});

test("empty / whitespace-only normalizes to empty string", () => {
  assert.equal(normalizeIntent("   "), "");
  assert.equal(normalizeIntent(""), "");
});
