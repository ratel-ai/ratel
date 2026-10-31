import assert from "node:assert/strict";
import { test } from "node:test";
import type { MatchQualityProposalRow } from "@/lib/synthesis/match-quality/schema";
import {
  catalogEditHref,
  descriptionsSearch,
  openTarget,
  projectionOf,
  revertedToast,
  rewriteEffect,
  rewriteForTool,
  rewriteRows,
  rewritesCount,
  runView,
  toolCard,
} from "./descriptions";

const CREATED = new Date("2026-10-15T14:11:09.000Z");

function proposal(overrides: Partial<MatchQualityProposalRow> = {}): MatchQualityProposalRow {
  return {
    id: "p1",
    runId: "r1",
    projectId: "project",
    entryId: "get_project_schedule",
    entryName: "get_project_schedule",
    status: "pending",
    currentSearchable: "Read a project's schedule.",
    currentSource: "runtime",
    proposedSearchable:
      "Read a project's schedule. Use to answer whether an activity is on track or behind.",
    rationale: "Added the on-track wording people type.",
    evidence: {
      misses: 12,
      targeted: 30,
      failures: [
        {
          query: "is the deck pour on track",
          ourRank: null,
          ourTop: "track_material_delivery",
          baselineTop: null,
          targetSource: "judge",
          selectionId: "s1",
        },
      ],
    },
    preview: {},
    backtest: {
      n: 400,
      delta: {
        containment: 0.04,
        quality: 0.03,
        interval: { low: 0.02, high: 0.06 },
        significant: true,
      },
      byEntry: [
        {
          entryId: "get_project_schedule",
          n: 20,
          lost: 0,
          delta: 0.5,
          containedBefore: 8,
          containedAfter: 19,
        },
      ],
    },
    appliedAt: null,
    appliedBy: null,
    revertedAt: null,
    previousOverride: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

function replay(delta: number, significant: boolean) {
  return {
    n: 840,
    before: { containment: 0.62, quality: 0.5 },
    after: { containment: 0.62 + delta, quality: 0.55 },
    delta: {
      containment: delta,
      quality: 0.05,
      interval: { low: delta - 0.03, high: delta + 0.03 },
      significant,
    },
    movements: { found: 40, lost: 0, promoted: 3, demoted: 0, unchanged: 797 },
    evidence: { invoked: 0, judged: 840 },
    reproductionRate: null,
  };
}

test("a rewrite's effect is its own tool's searches, found before and after, in points", () => {
  assert.deepEqual(rewriteEffect(proposal()), {
    delta: "+55 pts",
    direction: "up",
    tool: { n: 20, before: 8, after: 19 },
  });
  const catalogOnly = rewriteEffect(
    proposal({ backtest: { n: 80, delta: { containment: 0.06 } } }),
  );
  assert.deepEqual(
    catalogOnly,
    { delta: "+6 pts", direction: "up", tool: null },
    "older replays fall back to the whole catalog",
  );
  assert.equal(rewriteEffect(proposal({ backtest: null })), null);
});

test("rows: to review the most missed first, applied newest first, closed ones gone", () => {
  const rows = rewriteRows([
    proposal({
      id: "few",
      entryId: "notify_team",
      entryName: "notify_team",
      evidence: { misses: 2 },
    }),
    proposal({ id: "many", evidence: { misses: 40 } }),
    proposal({ id: "old", status: "applied", appliedAt: new Date("2026-10-01T00:00:00Z") }),
    proposal({ id: "new", status: "applied", appliedAt: new Date("2026-10-10T00:00:00Z") }),
    proposal({ id: "gone", status: "dismissed" }),
    proposal({ id: "stale", status: "superseded" }),
  ]);
  assert.deepEqual(
    rows.pending.map((row) => row.id),
    ["many", "few"],
  );
  assert.deepEqual(
    rows.applied.map((row) => row.id),
    ["new", "old"],
  );
  const [row] = rows.pending;
  assert.equal(row!.peek, "rewrite:many");
  assert.equal(row!.missed, 40);
  assert.equal(row!.change, "adds");
  assert.equal(row!.before, "Read a project's schedule.");
  assert.match(row!.after, /on track or behind/);
  assert.ok(row!.spans.some((span) => span.op === "added"));
});

test("applying every pending rewrite: the replay's change, only when it moved", () => {
  assert.deepEqual(projectionOf(replay(0.16, true), 4), {
    pending: 4,
    delta: "+16 pts",
    direction: "up",
    significant: true,
    replayed: 840,
  });
  assert.equal(projectionOf(replay(0.16, false), 4)?.significant, false);
  assert.equal(projectionOf(replay(0.16, true), 0), null, "nothing pending, nothing to project");
  assert.equal(projectionOf(null, 3), null);
  assert.equal(
    projectionOf(
      {
        ...replay(0, true),
        movements: { found: 0, lost: 0, promoted: 0, demoted: 0, unchanged: 840 },
        delta: { containment: 0, quality: 0, significant: false },
      },
      2,
    ),
    null,
    "a standing reading is no projection",
  );
});

test("?peek= opens a rewrite, ?tool= that tool's rewrite or its card", () => {
  const rows = rewriteRows([
    proposal({ id: "a" }),
    proposal({
      id: "b",
      entryId: "notify_team",
      entryName: "notify_team",
      status: "applied",
      appliedAt: CREATED,
    }),
  ]);
  const all = [...rows.pending, ...rows.applied];
  assert.equal(openTarget(all, "rewrite:b", null)?.kind, "rewrite");
  assert.equal(openTarget(all, "rewrite:missing", null), null);
  const forTool = openTarget(all, null, "get_project_schedule");
  assert.equal(forTool?.kind === "rewrite" ? forTool.row.id : null, "a");
  assert.deepEqual(openTarget(all, null, "search_spec_book"), {
    kind: "tool",
    toolId: "search_spec_book",
  });
  assert.equal(openTarget(all, "rewrite:b", "get_project_schedule")?.kind === "rewrite", true);
  assert.equal(rewriteForTool(all, null), null);
  const twice = rewriteRows([
    proposal({ id: "done", status: "applied", appliedAt: CREATED }),
    proposal({ id: "waiting" }),
  ]);
  assert.equal(
    rewriteForTool([...twice.pending, ...twice.applied], "get_project_schedule")?.id,
    "waiting",
    "a waiting rewrite before an applied one",
  );
});

test("opening or closing a panel spends ?tool= and keeps the rest of the address", () => {
  assert.equal(
    descriptionsSearch("?range=30d&tool=notify_team", "rewrite:a"),
    "?range=30d&peek=rewrite%3Aa",
  );
  assert.equal(descriptionsSearch("?peek=rewrite%3Aa&range=30d", null), "?range=30d");
  assert.equal(descriptionsSearch("", null), "");
});

test("a tool with no rewrite: its description, where it comes from, and its searches", () => {
  const card = toolCard(
    {
      entryId: "search_spec_book",
      name: "search_spec_book",
      searchable: "Search a project's spec book.",
      source: "override",
    },
    { searches: 12, first: 7, found: 10 },
    catalogEditHref("p1", "search_spec_book"),
  );
  assert.deepEqual(card, {
    id: "search_spec_book",
    name: "search_spec_book",
    description: "Search a project's spec book.",
    source: "Cloud override",
    tally: { searches: 12, first: 7, found: 10 },
    catalogHref: "/project/p1/catalogs/tools?highlight=search_spec_book",
  });
  assert.equal(
    toolCard(
      { entryId: "x", name: "x", searchable: "X.", source: "runtime" },
      { searches: 0, first: 0, found: 0 },
      "/c",
    ).tally,
    null,
  );
});

test("the words around a rewrite", () => {
  assert.deepEqual(revertedToast("notify_team", "undo"), {
    title: "Rewrite undone",
    description: "notify_team is back to its previous searchable description.",
  });
  assert.equal(revertedToast("notify_team", "revert").title, "Rewrite reverted");
  assert.equal(rewritesCount(1), "1 rewrite");
  assert.equal(rewritesCount(4), "4 rewrites");
  assert.deepEqual(runView({ status: "running", declinedReason: null }), {
    phase: "running",
    declinedReason: null,
  });
  assert.equal(runView(null), null);
});
