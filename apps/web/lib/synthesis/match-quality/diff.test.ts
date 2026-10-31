import assert from "node:assert/strict";
import { test } from "node:test";
import { changeShare, diffWords, isPureAddition, tokenize } from "./diff";

function render(spans: ReturnType<typeof diffWords>, ops: string[]): string {
  return spans
    .filter((span) => ops.includes(span.op))
    .map((span) => span.text)
    .join("");
}

test("tokenizing keeps trailing whitespace attached so spans rejoin exactly", () => {
  assert.deepEqual(tokenize("a bb  c"), ["a ", "bb  ", "c"]);
  assert.deepEqual(tokenize(""), []);
  assert.deepEqual(tokenize("   "), []);
});

test("an appended clause is one added run, with the rest left alone", () => {
  const before = "Refunds a payment.";
  const after = "Refunds a payment. Use when the customer asks for their money back.";
  const spans = diffWords(before, after);

  assert.deepEqual(
    spans.map((span) => span.op),
    ["same", "added"],
  );
  assert.equal(spans[1].text.trim(), "Use when the customer asks for their money back.");
});

test("same plus added reproduces the proposal, same plus removed reproduces the original", () => {
  const before = "Lists invoices for one account, newest first.";
  const after = "Lists invoices for an account. Use when asked to see billing history.";
  const spans = diffWords(before, after);

  assert.equal(render(spans, ["same", "added"]), after);
  assert.equal(render(spans, ["same", "removed"]), before);
});

test("an unchanged description produces no highlight at all", () => {
  const spans = diffWords("Exactly the same.", "Exactly the same.");
  assert.deepEqual(
    spans.map((span) => span.op),
    ["same"],
  );
  assert.equal(changeShare(spans), 0);
});

test("a wholesale rewrite is reported as such rather than as an append", () => {
  const spans = diffWords("Reverses a ledger entry.", "Cancels a subscription immediately.");
  assert.equal(isPureAddition(spans), false);
  assert.ok(changeShare(spans) > 0.5);
});

test("a pure append is recognised, so a reader can skim it", () => {
  const spans = diffWords("Does a thing.", "Does a thing. | Use cases: one; two");
  assert.equal(isPureAddition(spans), true);
});

test("adjacent changes of the same kind coalesce into one run", () => {
  const spans = diffWords("one two three", "one alpha beta three");
  const added = spans.filter((span) => span.op === "added");
  assert.equal(added.length, 1, "two consecutive new words are one highlight, not two");
  assert.equal(added[0].text.trim(), "alpha beta");
});

test("an empty original is entirely an addition", () => {
  const spans = diffWords("", "All new text.");
  assert.deepEqual(
    spans.map((span) => span.op),
    ["added"],
  );
  assert.equal(changeShare(spans), 1);
});

test("both empty is no spans, not a crash", () => {
  assert.deepEqual(diffWords("", ""), []);
  assert.equal(changeShare([]), 0);
  assert.equal(isPureAddition([]), false);
});

test("a pathological input degrades to a plain replacement instead of going quadratic", () => {
  const long = Array.from({ length: 600 }, (_unused, i) => `w${i}`).join(" ");
  const spans = diffWords(long, `${long} extra`);
  assert.deepEqual(
    spans.map((span) => span.op),
    ["removed", "added"],
  );
});

test("whitespace-only reflow of the same words is not a change", () => {
  const spans = diffWords("one two  three", "one\ntwo three");
  assert.ok(spans.every((span) => span.op === "same"));
  assert.equal(changeShare(spans), 0);
});
