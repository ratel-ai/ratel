import assert from "node:assert/strict";
import { test } from "node:test";
import { sliceWellFormed } from "@/lib/readings/text/well-formed";

test("a cut inside an emoji drops the whole emoji", () => {
  assert.equal(sliceWellFormed("ab😀cd", 3), "ab");
  assert.equal(sliceWellFormed("ab😀cd", 4), "ab😀");
});

test("short text is kept and plain text cuts at the limit", () => {
  assert.equal(sliceWellFormed("abc", 10), "abc");
  assert.equal(sliceWellFormed("abcdef", 3), "abc");
  assert.equal(sliceWellFormed("😀", 1), "");
});

test("a surrogate already alone in the text becomes the replacement character", () => {
  assert.equal(sliceWellFormed("ab\uD83Dcd", 10), "ab�cd");
  assert.equal(sliceWellFormed("ab\uDE00", 3), "ab�");
});
