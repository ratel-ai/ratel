import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_PER_SOURCE, mergePrompts } from "./prompts";

test("flagged prompts come first, worst disagreement at the top", () => {
  const merged = mergePrompts(
    [
      { query: "mild", comparisons: 40, mismatches: 1 },
      { query: "bad", comparisons: 10, mismatches: 9 },
    ],
    [{ text: "asked a lot", occurrences: 500 }],
  );
  assert.deepEqual(
    merged.map((prompt) => prompt.text),
    ["bad", "mild", "asked a lot"],
  );
  assert.equal(merged[0].source, "flagged");
  assert.equal(merged[0].mismatches, 9);
  assert.equal(merged[2].source, "frequent");
  assert.equal(merged[2].count, 500);
  assert.equal(merged[2].mismatches, null);
});

test("equal disagreement falls back to traffic", () => {
  const merged = mergePrompts(
    [
      { query: "quiet", comparisons: 3, mismatches: 2 },
      { query: "busy", comparisons: 30, mismatches: 2 },
    ],
    [],
  );
  assert.deepEqual(
    merged.map((prompt) => prompt.text),
    ["busy", "quiet"],
  );
});

test("a query in both sources appears once, as flagged", () => {
  // Flagged wins the tie: a disagreement is a live lead, while a high count on
  // its own is only context.
  const merged = mergePrompts(
    [{ query: "deploy the service", comparisons: 5, mismatches: 3 }],
    [{ text: "deploy the service", occurrences: 90 }],
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].source, "flagged");
  assert.equal(merged[0].mismatches, 3);
});

test("dedupe ignores case and surrounding space", () => {
  const merged = mergePrompts(
    [{ query: "  Review a PR  ", comparisons: 2, mismatches: 1 }],
    [{ text: "review a pr", occurrences: 10 }],
  );
  assert.deepEqual(
    merged.map((prompt) => prompt.text),
    ["Review a PR"],
  );
});

test("blank queries never become a prompt chip", () => {
  const merged = mergePrompts(
    [{ query: "   ", comparisons: 5, mismatches: 5 }],
    [{ text: "", occurrences: 9 }],
  );
  assert.deepEqual(merged, []);
});

test("each group is capped on its own, so neither crowds the other out", () => {
  // A busy project flags dozens of disagreements. Under a shared cap those ate
  // the whole list and the frequent asks never appeared at all.
  const merged = mergePrompts(
    Array.from({ length: 30 }, (_, i) => ({
      query: `flagged ${i}`,
      comparisons: 1,
      mismatches: 1,
    })),
    Array.from({ length: 30 }, (_, i) => ({
      text: `frequent ${i}`,
      occurrences: 1,
    })),
  );

  assert.equal(merged.length, MAX_PER_SOURCE * 2);
  assert.equal(merged.filter((prompt) => prompt.source === "flagged").length, MAX_PER_SOURCE);
  assert.equal(merged.filter((prompt) => prompt.source === "frequent").length, MAX_PER_SOURCE);
  // Flagged still lead the list.
  assert.equal(merged[0].source, "flagged");
  assert.equal(merged[MAX_PER_SOURCE].source, "frequent");
});

test("a deduped query does not cost the frequent group one of its slots", () => {
  // "shared" is claimed by the flagged group; the frequent group should still
  // fill its five from what is left rather than showing four.
  const merged = mergePrompts(
    [{ query: "shared", comparisons: 9, mismatches: 9 }],
    [
      { text: "shared", occurrences: 100 },
      ...Array.from({ length: 6 }, (_, i) => ({
        text: `frequent ${i}`,
        occurrences: 10 - i,
      })),
    ],
  );
  assert.equal(merged.filter((prompt) => prompt.source === "frequent").length, MAX_PER_SOURCE);
  assert.equal(merged.filter((prompt) => prompt.text === "shared").length, 1);
});

test("either source alone still produces a list", () => {
  assert.equal(mergePrompts([], [{ text: "only ask", occurrences: 1 }]).length, 1);
  assert.equal(mergePrompts([{ query: "only flag", comparisons: 1, mismatches: 1 }], []).length, 1);
  // A compared query the arms never disagreed on is not a lead, so it is not
  // offered under a heading that says they did.
  assert.deepEqual(mergePrompts([{ query: "agreed", comparisons: 9, mismatches: 0 }], []), []);
  assert.deepEqual(mergePrompts([], []), []);
});

test("only queries that actually disagreed reach the flagged group", () => {
  // The group is labelled "Arms disagreed on these". Filling its spare slots
  // from queries the arms agreed on says the opposite of what happened, and
  // those entries carry no selection so the click could not honour it either.
  const merged = mergePrompts(
    [
      {
        query: "they disagreed here",
        comparisons: 9,
        mismatches: 4,
        mismatchSelectionId: "sel-001",
        mismatchExperimentName: "reranker-shadow",
      },
      { query: "they agreed every time", comparisons: 40, mismatches: 0 },
    ],
    [],
  );

  assert.deepEqual(
    merged.map((prompt) => [prompt.text, prompt.source]),
    [["they disagreed here", "flagged"]],
  );
  assert.equal(merged[0].selectionId, "sel-001");
  assert.equal(merged[0].experimentName, "reranker-shadow");
});

test("a flagged prompt carries the disagreement it is offered for", () => {
  // Without it, picking from "Arms disagreed on these" ran a plain test and
  // showed no arms, so the menu promised a comparison the page did not have.
  const merged = mergePrompts(
    [
      {
        query: "deploy the service",
        comparisons: 3,
        mismatches: 2,
        mismatchSelectionId: "sel-031",
        mismatchExperimentName: "reranker-shadow",
      },
    ],
    [{ text: "write some tests", occurrences: 12 }],
  );

  const flagged = merged.find((prompt) => prompt.source === "flagged");
  const frequent = merged.find((prompt) => prompt.source === "frequent");
  assert.equal(flagged?.selectionId, "sel-031");
  // A frequent prompt is not offered as a comparison, so it opens nothing.
  assert.equal(frequent?.selectionId, null);
  assert.equal(frequent?.experimentName, null);
});
