import assert from "node:assert/strict";
import { test } from "node:test";
import { onboardingKeyNote } from "./key-note";

test("a key the edition kept can be revealed later", () => {
  assert.equal(onboardingKeyNote(true), "Copy it now or reveal it later in Project settings.");
});

test("without an edition that keeps keys, the key is not shown again", () => {
  assert.equal(onboardingKeyNote(false), "Copy it now; it is not shown again.");
});
