import assert from "node:assert/strict";
import { test } from "node:test";
import {
  needsUrlSync,
  type SearchBoxEvent,
  type SearchBoxState,
  searchBoxReducer,
  searchBoxState,
  searchToSend,
} from "./search-box";

function apply(state: SearchBoxState, ...events: SearchBoxEvent[]): SearchBoxState {
  return events.reduce(searchBoxReducer, state);
}

test("typing after a send survives the send landing, so no keystroke is lost", () => {
  let box = apply(searchBoxState(""), { type: "typed", text: "refu" });
  assert.equal(searchToSend(box), "refu");
  box = apply(box, { type: "sent", value: "refu" }, { type: "typed", text: "refund" });
  assert.equal(box.text, "refund", "the URL still says nothing, and the box keeps what was typed");
  box = apply(box, { type: "url", value: "refu", settled: false });
  assert.equal(box.text, "refund", "our own write landing does not reset the box");
  assert.equal(box.url, "refu");
  assert.equal(searchToSend(box), "refund", "the rest of the word goes next, never a fragment");
});

test("two writes in flight: the first landing keeps the second and the text", () => {
  const box = apply(
    searchBoxState(""),
    { type: "typed", text: "ab" },
    { type: "sent", value: "ab" },
    { type: "typed", text: "abc" },
    { type: "sent", value: "abc" },
    { type: "url", value: "ab", settled: false },
  );
  assert.deepEqual(box, { text: "abc", url: "ab", inFlight: ["abc"] });
  assert.equal(searchToSend(box), null, "abc is already on its way");
  assert.deepEqual(apply(box, { type: "url", value: "abc", settled: true }), {
    text: "abc",
    url: "abc",
    inFlight: [],
  });
});

test("the URL moving without the box (Back, a shared link) replaces the text and what was in flight", () => {
  const box = apply(
    searchBoxState("old"),
    { type: "typed", text: "draft" },
    { type: "sent", value: "draft" },
    { type: "url", value: "elsewhere", settled: true },
  );
  assert.deepEqual(box, searchBoxState("elsewhere"));
  assert.equal(searchToSend(box), null);
});

test("Clear filters empties the box and treats its own landing as its own", () => {
  let box = apply(searchBoxState("refund"), { type: "cleared" });
  assert.deepEqual(box, { text: "", url: "refund", inFlight: [""] });
  box = apply(box, { type: "typed", text: "ne" });
  box = apply(box, { type: "url", value: "", settled: true });
  assert.equal(box.text, "ne", "typed after clearing, kept when the clear lands");
  assert.equal(searchToSend(box), "ne");
  assert.deepEqual(
    apply(searchBoxState(""), { type: "cleared" }).inFlight,
    [],
    "nothing to clear, nothing in flight",
  );
});

test("a write overtaken by another navigation is sent again once everything settles", () => {
  let box = apply(
    searchBoxState(""),
    { type: "typed", text: "refund" },
    { type: "sent", value: "refund" },
  );
  assert.equal(needsUrlSync(box, "", false), false, "still loading: wait");
  assert.equal(needsUrlSync(box, "", true), true);
  box = apply(box, { type: "url", value: "", settled: true });
  assert.deepEqual(box, { text: "refund", url: "", inFlight: [] });
  assert.equal(searchToSend(box), "refund");
  assert.equal(needsUrlSync(box, "", true), false, "reconciled once, not in a loop");
});

test("only a real change is sent: trimmed, and not what the URL or the last write says", () => {
  const box = searchBoxState("refund");
  assert.equal(searchToSend(apply(box, { type: "typed", text: " refund " })), null);
  assert.equal(searchToSend(apply(box, { type: "typed", text: "  " })), "");
  assert.equal(
    searchToSend(apply(box, { type: "typed", text: "re" }, { type: "sent", value: "re" })),
    null,
  );
  assert.equal(
    apply(box, { type: "typed", text: "refund" }),
    box,
    "an unchanged event keeps the same state",
  );
});
