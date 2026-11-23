import assert from "node:assert/strict";
import { test } from "node:test";
import { sliceWellFormed, wellFormedJson } from "@/lib/readings/text/well-formed";

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

test("wellFormedJson repairs lone surrogates in strings and keys at any depth", () => {
  const out = wellFormedJson({ a: "x\uD83D", list: ["y\uDE00", { "k\uD83D": "z" }] });
  assert.deepEqual(out, { a: "x\uFFFD", list: ["y\uFFFD", { "k\uFFFD": "z" }] });
  assert.doesNotMatch(JSON.stringify(out), /\\ud[89ab-f]/i);
});

test("wellFormedJson changes nothing else: pairs, numbers, nulls, shape, and a literal backslash-u", () => {
  const value = {
    emoji: "ab😀",
    text: "the text \\ud83d",
    n: 1,
    off: false,
    none: null,
    gone: undefined,
    nested: [1, ["a"]],
  };
  assert.deepEqual(wellFormedJson(value), value);
  assert.equal(JSON.stringify(wellFormedJson(value)), JSON.stringify(value));
});

test("wellFormedJson leaves objects that are not plain as they are", () => {
  const at = new Date(0);
  const signal = new AbortController().signal;
  const out = wellFormedJson({ at, signal });
  assert.equal(out.at, at);
  assert.equal(out.signal, signal);
});
