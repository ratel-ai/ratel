import assert from "node:assert/strict";
import { test } from "node:test";
import type { MatchQualityProposalRow } from "@/lib/synthesis/match-quality/schema";
import {
  appliedToast,
  containmentDelta,
  EXAMPLES_SHOWN,
  missedLabel,
  NOT_REACHING_RUNTIME,
  revertedToast,
  settle,
  suggestionEffect,
  suggestionsSummary,
  toSuggestionRows,
} from "./suggestions";

const CREATED = new Date("2026-10-15T14:11:09.000Z");

function proposal(overrides: Partial<MatchQualityProposalRow> = {}): MatchQualityProposalRow {
  return {
    id: "p1",
    runId: "r1",
    projectId: "project",
    entryId: "update_task",
    entryName: "update_task",
    status: "pending",
    currentSearchable: "Update a task's fields.",
    currentSource: "runtime",
    proposedSearchable: "Update a task's fields. Use when someone moves a task to done.",
    rationale: "Added the wording these searches actually used.",
    evidence: {
      misses: 4,
      targeted: 9,
      failures: [
        {
          query: "move the task to done",
          ourRank: null,
          ourTop: "complete_task",
          baselineTop: null,
          targetSource: "invoked",
          selectionId: "s1",
        },
        {
          query: "close this ticket",
          ourRank: null,
          ourTop: "list_tasks",
          baselineTop: null,
          targetSource: "judge",
        },
        {
          query: "shown second",
          ourRank: 2,
          ourTop: "x",
          baselineTop: null,
          targetSource: "judge",
        },
      ],
    },
    preview: {},
    backtest: null,
    appliedAt: null,
    appliedBy: null,
    revertedAt: null,
    previousOverride: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

function replay(delta: number, significant: boolean, extra: Record<string, unknown> = {}) {
  return {
    n: 56,
    before: { containment: 0.79, quality: 0.74 },
    after: { containment: 0.79 + delta, quality: 0.8 },
    delta: {
      containment: delta,
      quality: 0.05,
      interval: { low: delta - 0.05, high: delta + 0.05 },
      significant,
    },
    movements: {
      found: delta > 0 ? 3 : 0,
      lost: delta < 0 ? 2 : 0,
      promoted: 0,
      demoted: 0,
      unchanged: 50,
    },
    evidence: { invoked: 56, judged: 0 },
    reproductionRate: 0.5,
    baseline: null,
    baselineN: 0,
    ...extra,
  };
}

test("pending rows come worst first, applied ones apart, and decided ones not at all", () => {
  const rows = toSuggestionRows(
    [
      proposal({ id: "small", entryName: "b_tool", evidence: { misses: 1 } }),
      proposal({ id: "big", entryName: "a_tool", evidence: { misses: 9 } }),
      proposal({ id: "done", status: "applied", appliedAt: new Date("2026-10-16T08:00:00Z") }),
      proposal({ id: "gone", status: "dismissed" }),
      proposal({ id: "old", status: "superseded" }),
      proposal({ id: "back", status: "reverted" }),
    ],
    () => null,
  );
  assert.deepEqual(
    rows.pending.map((row) => row.id),
    ["big", "small"],
  );
  assert.deepEqual(
    rows.applied.map((row) => [row.id, row.appliedAt]),
    [["done", "2026-10-16T08:00:00.000Z"]],
  );
});

test("a row says what changes, why, and which searches it missed, with a test link each", () => {
  const seen: Array<[string, string | null]> = [];
  const [row] = toSuggestionRows([proposal()], (query, selectionId) => {
    seen.push([query, selectionId]);
    return `/playground?q=${encodeURIComponent(query)}`;
  }).pending;
  assert.equal(row!.change, "adds", "only words were added");
  assert.equal(row!.missed, 4);
  assert.deepEqual(
    row!.examples.map((example) => example.query),
    ["move the task to done", "close this ticket"],
    "a search the tool was shown on is not a miss",
  );
  assert.deepEqual(seen, [
    ["move the task to done", "s1"],
    ["close this ticket", null],
  ]);
  assert.equal(row!.moreExamples, 2, "counted in searches, not phrasings");
  assert.ok(row!.spans.some((span) => span.op === "added" && span.text.includes("Use")));
  const rewrite = toSuggestionRows([proposal({ proposedSearchable: "Change a task." })], () => null)
    .pending[0]!;
  assert.equal(rewrite.change, "rewrites");
  const many = proposal({
    evidence: {
      misses: 20,
      failures: Array.from({ length: 9 }, (_, index) => ({
        query: `q${index}`,
        ourRank: null,
        targetSource: "judge",
      })),
    },
  });
  assert.equal(toSuggestionRows([many], () => null).pending[0]!.examples.length, EXAMPLES_SHOWN);
});

test("the effect leads with the tool's own searches, in points", () => {
  const own = suggestionEffect(
    proposal({
      backtest: {
        byEntry: [
          { entryId: "other", n: 9, lost: 0, containedBefore: 0, containedAfter: 9 },
          { entryId: "update_task", n: 5, lost: 0, containedBefore: 3, containedAfter: 5 },
        ],
      },
    }),
  );
  assert.deepEqual(own, { delta: "+40 pts", direction: "up", detail: "3 → 5 of 5 searches" });
  const catalog = suggestionEffect(proposal({ backtest: replay(0.2, true) }));
  assert.equal(catalog?.delta, "+20 pts");
  assert.equal(catalog?.detail, "79% → 99% of all searches");
  assert.equal(suggestionEffect(proposal()), null, "never replayed");
  assert.equal(suggestionEffect(proposal({ backtest: { n: 0 } })), null);
});

test("the replay's change is read defensively from stored JSON", () => {
  assert.equal(containmentDelta(replay(0.2, true)), 0.2);
  assert.equal(containmentDelta({ delta: { containment: "0.2" } }), null);
  assert.equal(containmentDelta(null), null);
  assert.equal(containmentDelta({}), null);
});

test("the set is summed up in one sentence that states the change", () => {
  assert.equal(
    suggestionsSummary(replay(0.2, true), 9),
    "Replayed on your past searches, applying all 9 finds the right tool 20 points more often.",
  );
  assert.equal(
    suggestionsSummary(replay(0.01, false), 1),
    "Replayed on your past searches, applying it finds the right tool 1 point more often, within the margin of error.",
  );
  assert.equal(
    suggestionsSummary(replay(-0.03, true), 2),
    "Replayed on your past searches, applying all 2 finds the right tool 3 points less often.",
  );
  assert.equal(
    suggestionsSummary(replay(0.002, false), 3),
    "Replayed on your past searches, applying all 3 does not change how often the right tool is found.",
  );
  assert.equal(
    suggestionsSummary(replay(0.2, true), 0),
    null,
    "nothing pending, nothing to sum up",
  );
  assert.equal(suggestionsSummary(null, 4), null);
  const standing = {
    ...replay(0, false),
    movements: { found: 0, lost: 0, promoted: 0, demoted: 0 },
    delta: { containment: 0, quality: 0 },
  };
  assert.equal(
    suggestionsSummary(standing, 4),
    null,
    "a standing reading says nothing about these rewrites",
  );
  for (const sentence of [suggestionsSummary(replay(0.2, true), 9), missedLabel(3)]) {
    assert.doesNotMatch(sentence ?? "", /\u2014|BM25|keyword-only|judge/i);
  }
});

test("an action that throws comes back as a failure with something to say", async () => {
  assert.deepEqual(await settle(async () => ({ ok: true })), { ok: true });
  assert.deepEqual(
    await settle(async () => ({ ok: false, message: "That proposal has already been acted on." })),
    {
      ok: false,
      message: "That proposal has already been acted on.",
    },
  );
  const thrown = await settle(async () => {
    throw new Error("fetch failed");
  });
  assert.equal(thrown.ok, false);
  assert.match(thrown.ok ? "" : thrown.message, /Nothing changed; try again in a moment\./);
  assert.equal(
    (await settle(async () => ({ ok: false }))).ok,
    false,
    "an error answer without a message still says something",
  );
});

test("applying promises the new wording only when the agent fetches overrides", () => {
  assert.deepEqual(appliedToast("update_task", true), {
    title: "Rewrite applied",
    description: "update_task now matches searches with the new wording.",
  });
  for (const unknown of [null, false]) {
    const toast = appliedToast("update_task", unknown);
    assert.equal(toast.title, "Rewrite saved in Cloud");
    assert.doesNotMatch(toast.description, /now matches/);
  }
  assert.match(NOT_REACHING_RUNTIME, /may not reach your agent yet/);
});

test("undo and revert both say the fix is closed", () => {
  assert.deepEqual(revertedToast("update_task", "undo"), {
    title: "Rewrite undone",
    description: "update_task is back to its previous description, and this fix is closed.",
  });
  assert.equal(revertedToast("update_task", "revert").title, "Rewrite reverted");
});

test("missed counts read as words", () => {
  assert.equal(missedLabel(0), "No recorded miss");
  assert.equal(missedLabel(1), "Missed 1 search");
  assert.equal(missedLabel(17), "Missed 17 searches");
});
