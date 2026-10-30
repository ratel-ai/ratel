import assert from "node:assert/strict";
import { test } from "node:test";
import type { RankingDiffEntry } from "@/lib/synthesis/experiments/ranking";
import { playgroundHref } from "./links";
import { RANKED_HIT_DEFAULTS } from "./test-support";
import type { RankedHit } from "./types";
import {
  diffByIndexedId,
  droppedIds,
  emptyBucketReason,
  formatRankScore,
  meterCells,
  modeHint,
  modeLabel,
  movementLabel,
  movementTone,
  sharePercent,
} from "./view";

const entry = (over: Partial<RankingDiffEntry>): RankingDiffEntry => ({
  id: "x",
  change: "stable",
  servedRank: 1,
  shadowRank: 1,
  ...over,
});

test("formatRankScore keeps three decimals and never invents a percentage", () => {
  assert.equal(formatRankScore(2.85914), "2.859");
  assert.equal(formatRankScore(0), "0.000");
  assert.equal(formatRankScore(Number.NaN), "—");
});

test("movementLabel reads from the drafted column's point of view", () => {
  // Rank 4 → rank 2 is a rise of two places.
  assert.equal(movementLabel(entry({ change: "moved", servedRank: 4, shadowRank: 2 })), "▲2");
  assert.equal(movementLabel(entry({ change: "moved", servedRank: 1, shadowRank: 3 })), "▼2");
  assert.equal(movementLabel(entry({ change: "stable" })), null);
  assert.equal(movementLabel(entry({ change: "added", servedRank: null, shadowRank: 1 })), "new");
  assert.equal(
    movementLabel(entry({ change: "dropped", servedRank: 2, shadowRank: null })),
    "dropped",
  );
  assert.equal(movementLabel(undefined), null);
});

test("movementTone marks rises as good and drops as bad", () => {
  assert.equal(movementTone(entry({ change: "moved", servedRank: 4, shadowRank: 2 })), "up");
  assert.equal(movementTone(entry({ change: "moved", servedRank: 1, shadowRank: 3 })), "down");
  assert.equal(movementTone(entry({ change: "added" })), "up");
  assert.equal(movementTone(entry({ change: "dropped" })), "down");
  assert.equal(movementTone(entry({ change: "stable" })), "neutral");
  assert.equal(movementTone(undefined), "neutral");
});

test("diffByIndexedId and droppedIds index a bucket's entries", () => {
  const entries = [
    entry({ id: "a", change: "stable" }),
    entry({ id: "b", change: "dropped", shadowRank: null }),
    entry({ id: "c", change: "dropped", shadowRank: null }),
  ];
  assert.equal(diffByIndexedId(entries).get("b")?.change, "dropped");
  assert.deepEqual(droppedIds(entries), ["b", "c"]);
  assert.deepEqual(droppedIds([]), []);
});

test("emptyBucketReason distinguishes an empty catalog from a non-match", () => {
  const hit: RankedHit = {
    ...RANKED_HIT_DEFAULTS,
    id: "a",
    kind: "skill",
    rank: 1,
    score: 1,
    bm25Score: 1,
    embeddingScore: null,
    description: "d",
    edited: false,
  };
  assert.equal(emptyBucketReason([hit], 3, "bm25"), null);
  assert.match(emptyBucketReason([], 0, "bm25") ?? "", /Nothing in this catalog/);
  assert.match(emptyBucketReason([], 3, "bm25") ?? "", /shares a word/);
  assert.match(emptyBucketReason([], 3, "embeddings") ?? "", /could be scored/);
});

test("mode hints stay short and never quote the live weight", () => {
  assert.match(modeHint("bm25"), /Matches words/);
  assert.match(modeHint("embeddings"), /Matches meaning/);
  assert.match(modeHint("hybrid"), /mixed by the slider/);
  for (const mode of ["bm25", "embeddings", "hybrid"] as const) {
    // A percentage here would go stale the moment the slider moves, and these
    // have to fit a tooltip.
    assert.doesNotMatch(modeHint(mode), /\d+%/);
    assert.ok(modeHint(mode).length <= 160, `${mode} hint is too long`);
  }
  assert.equal(modeLabel("hybrid"), "Hybrid");
});

test("playgroundHref carries only the context it was given", () => {
  assert.equal(playgroundHref("p1", {}), "/project/p1/playground");
  assert.equal(
    playgroundHref("p1", { query: "  review a PR  " }),
    "/project/p1/playground?q=review+a+PR",
  );
  const full = playgroundHref("p1", {
    query: "q",
    selectionId: "sel-001",
    experimentName: "reranker-shadow",
  });
  assert.match(full, /selection=sel-001/);
  assert.match(full, /experiment=reranker-shadow/);
});

test("playgroundHref bounds the carried query to what the route accepts", () => {
  const href = playgroundHref("p1", { query: "x".repeat(5_000) });
  const carried = new URL(href, "https://example.com").searchParams.get("q");
  assert.equal(carried?.length, 1_000);
});

test("meterCells never rounds a real score down to an empty meter", () => {
  // A capability that scored is not the same as one that did not, and an empty
  // meter would say it was.
  assert.equal(meterCells(0.01, 12), 1);
  assert.equal(meterCells(0, 12), 0);
  assert.equal(meterCells(1, 12), 12);
  assert.equal(meterCells(0.5, 12), 6);
  // Clamped rather than trusted: a caller's rounding must not overrun the row.
  assert.equal(meterCells(4, 12), 12);
  assert.equal(meterCells(Number.NaN, 12), 0);
  assert.equal(meterCells(-1, 12), 0);
});

test("sharePercent reports a whole percentage of the column leader", () => {
  assert.equal(sharePercent(1), 100);
  assert.equal(sharePercent(0.734), 73);
  assert.equal(sharePercent(0), 0);
  assert.equal(sharePercent(Number.NaN), 0);
});
