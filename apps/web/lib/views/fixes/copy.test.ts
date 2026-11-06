import assert from "node:assert/strict";
import { test } from "node:test";
import { fixShortTitle, fixTitle } from "@/lib/views/fixes/copy";
import { FIX_KINDS } from "@/lib/views/fixes/kinds";

/** Words the product never shows (DESIGN.md, The product's nouns). */
const FORBIDDEN = /workflow|tool craft|suggestion|proposal|signal|craft|topic|jev|bm25|\u2014/i;

test("a short title is verb first and leaves every name to the pins beside it", () => {
  const context = {
    tools: ["lookup_order", "find_task", "assign_task"],
    task: "Hand a task over",
    topic: "Order status",
    ask: null,
    count: null,
    topK: null,
  };
  for (const kind of FIX_KINDS) {
    const short = fixShortTitle(kind, context);
    for (const name of [...context.tools, context.task, context.topic])
      assert.ok(!short.includes(name), `${kind}: ${short}`);
    assert.doesNotMatch(short, FORBIDDEN, short);
    assert.equal(short[0], short[0]!.toUpperCase(), short);
    // One line in a row: never a sentence.
    assert.ok(!/[.!?]$/.test(short) && short.length <= 40, `${kind}: ${short}`);
  }
});

test("a short title keeps its counts", () => {
  assert.equal(fixShortTitle("merge", { tools: ["a", "b"] }), "Merge 2 tools into one");
  assert.equal(
    fixShortTitle("combine", { tools: ["a", "b", "c"] }),
    "Combine 3 steps into one tool",
  );
  assert.equal(fixShortTitle("retire", { tools: ["a"], count: 18 }), "Retire 18 tools nobody uses");
  assert.equal(fixShortTitle("retire", { tools: ["a"] }), "Retire a tool");
  assert.equal(fixShortTitle("tell-apart", { tools: ["a", "b"] }), "Tell 2 tools apart");
  assert.equal(fixShortTitle("skill", { tools: ["a", "b"] }), "Add a skill for 2 steps");
  // A setting has no names to leave out: it says its numbers.
  assert.equal(
    fixShortTitle("fewer-results", { tools: [], topK: { from: 10, to: 5 } }),
    fixTitle("fewer-results", { tools: [], topK: { from: 10, to: 5 } }),
  );
});
