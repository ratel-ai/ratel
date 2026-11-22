import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MEMBER_TEXT_MAX_CHARS,
  MEMBER_TEXT_MAX_PHRASES,
  mergeMemberText,
  splitMemberText,
} from "@/lib/readings/query-intents/member-text";

test("merges new phrases after the existing ones, deduped by normalized form", () => {
  const merged = mergeMemberText("refund their order", [
    "Refund their order.",
    "get a refund for their order",
  ]);
  assert.deepEqual(splitMemberText(merged), ["refund their order", "get a refund for their order"]);
});

test("the canonical's own phrase is never stored as a member", () => {
  const merged = mergeMemberText("", ["cancel their plan", "cancel my plan"], "cancel their plan");
  assert.deepEqual(splitMemberText(merged), ["cancel my plan"]);
});

test("is idempotent: merging the same batch twice changes nothing", () => {
  const once = mergeMemberText("", ["a b c", "d e f"]);
  assert.equal(mergeMemberText(once, ["a b c", "d e f"]), once);
});

test("returns the input unchanged when nothing new arrives", () => {
  assert.equal(mergeMemberText("keep me", []), "keep me");
  assert.equal(mergeMemberText("keep me", ["  ", "KEEP ME"]), "keep me");
});

test("caps the phrase count, dropping the oldest first", () => {
  const phrases = Array.from(
    { length: MEMBER_TEXT_MAX_PHRASES + 5 },
    (_, i) => `phrase number ${i}`,
  );
  const kept = splitMemberText(mergeMemberText("", phrases));
  assert.equal(kept.length, MEMBER_TEXT_MAX_PHRASES);
  assert.equal(kept[0], "phrase number 5");
  assert.equal(kept.at(-1), `phrase number ${MEMBER_TEXT_MAX_PHRASES + 4}`);
});

test("caps the joined length, again from the front", () => {
  const long = "x".repeat(1500);
  const kept = splitMemberText(mergeMemberText("", [`${long}a`, `${long}b`, `${long}c`]));
  assert.ok(kept.join("\n").length <= MEMBER_TEXT_MAX_CHARS);
  assert.equal(kept.at(-1), `${long}c`, "the newest phrase survives");
});
