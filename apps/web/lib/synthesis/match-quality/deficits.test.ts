import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_CANDIDATES, pickCandidates } from "./deficits";
import type { EvalItem } from "./types";

const AT = new Date("2026-09-10T12:00:00Z");

function item(
  target: string,
  ours: string[],
  baseline: string[] = [],
  query: string | null = `find ${target}`,
): EvalItem {
  return {
    selectionId: `sel-${target}-${ours.join(".")}-${query ?? "x"}`,
    occurredAt: AT,
    query,
    targetEntryId: target,
    targetKind: "tool",
    targetSource: "invoked",
    arms: [
      { arm: "ratel", role: "serving", resultIds: ours, resultScores: null },
      { arm: "legacy", role: "shadow", resultIds: baseline, resultScores: null },
    ],
  };
}

test("a target we never returned is a candidate; one shown below first is not", () => {
  const items = [
    item("missed", ["other"], ["missed"]),
    item("shown", ["other", "shown"], ["shown"]),
  ];
  const candidates = pickCandidates(items, "ratel", "legacy");
  assert.deepEqual(
    candidates.map((c) => c.entryId),
    ["missed"],
  );
  assert.equal(candidates[0].misses, 1);
  assert.equal(candidates[0].buried, 0);
  assert.equal(candidates[0].loss, 1);
});

test("a shown-below-first search is counted beside a miss but adds no loss or row", () => {
  const items = [
    item("mixed", ["other"], ["mixed"]),
    item("mixed", ["other", "mixed"], ["mixed"], "second ask"),
  ];
  const [candidate] = pickCandidates(items, "ratel", "legacy");
  assert.equal(candidate.misses, 1);
  assert.equal(candidate.buried, 1);
  assert.equal(candidate.loss, 1);
  assert.deepEqual(
    candidate.failures.map((failure) => failure.ourRank),
    [null],
  );
});

test("an entry we already rank first is not a candidate", () => {
  const candidates = pickCandidates([item("fine", ["fine", "other"])], "ratel", "legacy");
  assert.deepEqual(candidates, []);
});

test("distractions are counted but never nominate an entry on their own", () => {
  const items = [
    item("wanted", ["noise"], ["wanted"]),
    item("wanted", ["noise"], ["wanted"], "another ask"),
  ];
  const candidates = pickCandidates(items, "ratel", "legacy");
  assert.deepEqual(
    candidates.map((c) => c.entryId),
    ["wanted"],
  );
  assert.equal(candidates[0].distractions, 0);
  const noise = candidates.find((c) => c.entryId === "noise");
  assert.equal(noise, undefined);
});

test("failures carry what we returned instead and what the baseline chose", () => {
  const [candidate] = pickCandidates(
    [item("wanted", ["wrong", "alsowrong"], ["wanted", "other"])],
    "ratel",
    "legacy",
  );
  assert.deepEqual(candidate.failures, [
    {
      selectionId: "sel-wanted-wrong.alsowrong-find wanted",
      query: "find wanted",
      ourRank: null,
      ourTop: "wrong",
      baselineTop: "wanted",
      targetSource: "invoked",
    },
  ]);
});

test("an arm that is absent from a selection does not crash the scan", () => {
  const orphan: EvalItem = {
    selectionId: "orphan",
    occurredAt: AT,
    query: "q",
    targetEntryId: "wanted",
    targetKind: "tool",
    targetSource: "reference",
    arms: [{ arm: "legacy", role: "serving", resultIds: ["wanted"], resultScores: null }],
  };
  const candidates = pickCandidates([orphan], "ratel", "legacy");
  assert.deepEqual(candidates, []);
});

test("the display name comes from the corpus, falling back to the id", () => {
  const items = [item("wanted", ["other"], ["wanted"])];
  const named = pickCandidates(items, "ratel", "legacy", {
    nameById: new Map([["wanted", "search_documents"]]),
  });
  assert.equal(named[0].name, "search_documents");
  const unnamed = pickCandidates(items, "ratel", "legacy");
  assert.equal(unnamed[0].name, "wanted");
});

test("the candidate list is capped, keeping the worst", () => {
  const items: EvalItem[] = [];
  for (let i = 0; i < MAX_CANDIDATES + 5; i++) {
    // Earlier entries lose more searches, so they must survive the cap.
    const losses = MAX_CANDIDATES + 5 - i;
    for (let n = 0; n < losses; n++) {
      items.push(item(`tool-${i}`, ["other"], [`tool-${i}`], `ask ${i} ${n}`));
    }
  }
  const candidates = pickCandidates(items, "ratel", "legacy");
  assert.equal(candidates.length, MAX_CANDIDATES);
  assert.equal(candidates[0].entryId, "tool-0");
  assert.ok(!candidates.some((c) => c.entryId === `tool-${MAX_CANDIDATES + 4}`));
});

test("evidence queries per candidate are bounded and deduplicated", () => {
  const items: EvalItem[] = [];
  for (let n = 0; n < 40; n++) {
    items.push(item("wanted", ["other"], ["wanted"], "the same ask"));
  }
  const [candidate] = pickCandidates(items, "ratel", "legacy");
  assert.equal(candidate.misses, 40);
  assert.equal(candidate.failures.length, 1);
});

test("an uncaptured query still counts as a loss but carries no text", () => {
  const [candidate] = pickCandidates(
    [item("wanted", ["other"], ["wanted"], null)],
    "ratel",
    "legacy",
  );
  assert.equal(candidate.misses, 1);
  assert.deepEqual(candidate.failures, [
    {
      selectionId: "sel-wanted-other-x",
      query: null,
      ourRank: null,
      ourTop: "other",
      baselineTop: "wanted",
      targetSource: "invoked",
    },
  ]);
});
