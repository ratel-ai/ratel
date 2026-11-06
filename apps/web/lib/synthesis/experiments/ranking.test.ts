import assert from "node:assert/strict";
import { test } from "node:test";
import { diffRankings, resolveExperimentKind, summarizeRankingDiff } from "./ranking";

test("resolveExperimentKind picks ranking-shadow when comparison records exist", () => {
  assert.equal(resolveExperimentKind({ comparisonCount: 3 }), "ranking-shadow");
  assert.equal(resolveExperimentKind({ comparisonCount: 0 }), "generic");
});

test("summarizeRankingDiff counts entries by change kind", () => {
  const summary = summarizeRankingDiff([
    { id: "a", change: "stable", servedRank: 1, shadowRank: 1 },
    { id: "b", change: "moved", servedRank: 2, shadowRank: 3 },
    { id: "c", change: "dropped", servedRank: 3, shadowRank: null },
    { id: "d", change: "added", servedRank: null, shadowRank: 2 },
    { id: "e", change: "added", servedRank: null, shadowRank: 4 },
  ]);

  assert.deepEqual(summary, {
    stable: 1,
    moved: 1,
    dropped: 1,
    added: 2,
  });
});

test("diffRankings marks ids ranked differently by the shadow arm as moved", () => {
  const diff = diffRankings(
    ["update_task", "complete_task", "list_tasks"],
    ["complete_task", "update_task", "list_tasks"],
  );

  assert.deepEqual(diff, [
    { id: "update_task", change: "moved", servedRank: 1, shadowRank: 2 },
    { id: "complete_task", change: "moved", servedRank: 2, shadowRank: 1 },
    { id: "list_tasks", change: "stable", servedRank: 3, shadowRank: 3 },
  ]);
});

test("diffRankings marks served-only ids dropped and appends shadow-only ids as added", () => {
  const diff = diffRankings(
    ["update_task", "archive_task"],
    ["update_task", "create_task", "link_pr"],
  );

  assert.deepEqual(diff, [
    { id: "update_task", change: "stable", servedRank: 1, shadowRank: 1 },
    { id: "archive_task", change: "dropped", servedRank: 2, shadowRank: null },
    { id: "create_task", change: "added", servedRank: null, shadowRank: 2 },
    { id: "link_pr", change: "added", servedRank: null, shadowRank: 3 },
  ]);
});

test("diffRankings marks identically ranked ids as stable", () => {
  const diff = diffRankings(["update_task", "complete_task"], ["update_task", "complete_task"]);

  assert.deepEqual(diff, [
    { id: "update_task", change: "stable", servedRank: 1, shadowRank: 1 },
    { id: "complete_task", change: "stable", servedRank: 2, shadowRank: 2 },
  ]);
});
