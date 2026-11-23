import assert from "node:assert/strict";
import { test } from "node:test";
import type { EvaluableSelection } from "@/lib/synthesis/quality/ground-truth";
import { chooseSource, resolveOurArm, windowCut } from "./load-misses";
import { MAX_LISTED_MISSES, RANKED_ITEMS_SHOWN, toMissRows } from "./miss-rows";
import {
  findMissGroup,
  groupMisses,
  matchesSearch,
  outcomeOf,
  rankLabel,
  rightAnswer,
  type ScoredSearch,
  scoreSearches,
  toolTallies,
  within,
} from "./misses";

const DAY = 86_400_000;
const END = new Date("2026-10-15T00:00:00.000Z");

let sequence = 0;
function selection(
  overrides: Partial<EvaluableSelection> & { ours?: string[]; theirs?: string[] } = {},
): EvaluableSelection {
  sequence += 1;
  const { ours = ["a", "b", "c"], theirs, ...rest } = overrides;
  return {
    selectionId: `s${sequence}`,
    occurredAt: new Date(END.getTime() - DAY / 2),
    query: "create a task",
    arms: [
      { arm: "ratel", role: "serving", resultIds: ours },
      ...(theirs ? [{ arm: "legacy", role: "shadow" as const, resultIds: theirs }] : []),
    ],
    invokedToolId: null,
    invokedRank: null,
    ...rest,
  };
}

test("the right tool comes from what ran, then the answer key; never a guess", () => {
  assert.deepEqual(
    rightAnswer(selection({ invokedToolId: "x", judgedToolId: "y", judgedFrom: "judge" })),
    {
      target: "x",
      evidence: "seen",
    },
  );
  assert.deepEqual(rightAnswer(selection({ judgedToolId: "y", judgedFrom: "invoked" })), {
    target: "y",
    evidence: "seen",
  });
  assert.deepEqual(rightAnswer(selection({ judgedToolId: "y", judgedFrom: "judge" })), {
    target: "y",
    evidence: "judged",
  });
  assert.equal(rightAnswer(selection({ unclear: true })), null, "an undecided request is left out");
  assert.equal(rightAnswer(selection()), null, "nobody knows: no row, no score");
});

test("each answered search is scored against our ranking, with the other variant beside it", () => {
  const scored = scoreSearches(
    [
      selection({ judgedToolId: "a", judgedFrom: "judge" }),
      selection({ judgedToolId: "c", judgedFrom: "invoked", theirs: ["c", "a"] }),
      selection({ judgedToolId: "z", judgedFrom: "judge" }),
      selection(),
    ],
    "ratel",
  );
  assert.equal(scored.length, 3, "the unanswered search is dropped");
  assert.deepEqual(
    scored.map((search) => search.rank),
    [1, 3, null],
  );
  assert.equal(scored[1]!.comparison?.arm, "legacy");
  assert.equal(scored[1]!.ours.served, true);
  assert.deepEqual(
    scoreSearches([selection({ judgedToolId: "a" })], "missing-arm"),
    [],
    "no list of ours, nothing to score",
  );
});

test("a seen-it-run search from our own list stays a labelled row in the list", () => {
  const scoredRows = scoreSearches(
    [selection({ judgedToolId: "c", judgedFrom: "invoked" })],
    "ratel",
  );
  assert.equal(scoredRows.length, 1, "the list keeps it, labelled; the headline never counts it");
  assert.equal(scoredRows[0]!.evidence, "seen");
  assert.equal(scoredRows[0]!.ours.served, true);
});

function scored(overrides: Partial<ScoredSearch> = {}): ScoredSearch {
  sequence += 1;
  return {
    selectionId: `x${sequence}`,
    occurredAt: new Date(END.getTime() - DAY),
    query: "deploy to staging",
    target: "vercel_promote",
    evidence: "judged",
    ours: {
      arm: "ratel",
      served: true,
      resultIds: ["flaky_deploy", "vercel_logs", "vercel_promote"],
    },
    comparison: null,
    rank: 3,
    ...overrides,
  };
}

test("misses group by request and right tool, most frequent first, latest ranking shown", () => {
  const older = scored({
    selectionId: "old",
    occurredAt: new Date(END.getTime() - 3 * DAY),
    evidence: "judged",
  });
  const newer = scored({
    selectionId: "new",
    query: "Deploy to  staging",
    evidence: "seen",
    rank: null,
    ours: { arm: "ratel", served: true, resultIds: ["flaky_deploy"] },
  });
  const other = scored({
    selectionId: "solo",
    query: "find order 1042",
    target: "lookup_order",
    occurredAt: END,
  });
  const hit = scored({ selectionId: "hit", rank: 1 });
  const groups = groupMisses([older, other, newer, hit]);
  assert.deepEqual(
    groups.map((group) => [group.id, group.count]),
    [
      ["new", 2],
      ["solo", 1],
    ],
  );
  const deploy = groups[0]!;
  assert.equal(deploy.evidence, "seen", "seeing it run outranks a verdict");
  assert.deepEqual(deploy.selectionIds, ["old", "new"]);
  assert.equal(deploy.latest.rank, null);
  assert.equal(findMissGroup(groups, "old"), deploy, "an older shared link still opens the row");
  assert.equal(findMissGroup(groups, "hit"), null);
  assert.equal(findMissGroup(groups, null), null);
  const uncaptured = groupMisses([
    scored({ query: null, selectionId: "q1" }),
    scored({ query: null, selectionId: "q2" }),
  ]);
  assert.equal(uncaptured.length, 2, "searches without query text are never folded together");
});

test("rows carry names, both rankings and the links, capped for the list", () => {
  const group = groupMisses([
    scored({
      selectionId: "s",
      ours: {
        arm: "ratel",
        served: true,
        resultIds: Array.from({ length: 12 }, (_, index) => `t${index}`),
      },
      comparison: { arm: "legacy", served: false, resultIds: ["t9", "vercel_promote"] },
      target: "vercel_promote",
      rank: null,
    }),
  ]);
  const [row] = toMissRows(group, {
    name: (id) => id.toUpperCase(),
    traceHref: () => "/trace",
    test: () => ({ kind: "selection", selectionId: "s", experimentName: "cal" }),
    rewrite: (id) => (id === "vercel_promote" ? "pending" : null),
  });
  assert.equal(row!.expected.name, "VERCEL_PROMOTE");
  assert.equal(row!.rankedFirst?.id, "t0");
  assert.equal(row!.ours.items.length, RANKED_ITEMS_SHOWN);
  assert.equal(row!.ours.more, 2);
  assert.equal(row!.comparisonRank, 2);
  assert.equal(row!.traceHref, "/trace");
  assert.deepEqual(row!.test, { kind: "selection", selectionId: "s", experimentName: "cal" });
  assert.equal(row!.rewrite, "pending", "the right tool's rewrite rides on the row");
  const many = groupMisses(
    Array.from({ length: MAX_LISTED_MISSES + 5 }, (_, index) => scored({ query: `q${index}` })),
  );
  assert.equal(
    toMissRows(many, {
      name: (id) => id,
      traceHref: () => null,
      test: () => null,
      rewrite: () => null,
    }).length,
    MAX_LISTED_MISSES,
  );
});

test("rank words and the list filter", () => {
  assert.equal(rankLabel(null), "Not returned");
  assert.equal(rankLabel(2), "Ranked 2nd");
  assert.equal(rankLabel(3), "Ranked 3rd");
  assert.equal(rankLabel(11), "Ranked 11th");
  assert.equal(rankLabel(22), "Ranked 22nd");
  const row = {
    query: "deploy to staging",
    rankedFirstName: "flaky_deploy_api",
    expectedName: "vercel_promote",
  };
  assert.equal(matchesSearch(row, "  "), true);
  assert.equal(matchesSearch(row, "STAGING"), true);
  assert.equal(matchesSearch(row, "promote"), true);
  assert.equal(matchesSearch(row, "billing"), false);
  assert.equal(matchesSearch({ ...row, query: null }, "staging"), false, "no query text to match");
  assert.equal(matchesSearch({ ...row, query: null }, "flaky"), true, "the tools still match");
});

test("only searches inside the window count", () => {
  const window = { since: new Date(END.getTime() - DAY), until: END };
  const inside = scored({ occurredAt: new Date(END.getTime() - 1000) });
  const edge = scored({ occurredAt: END });
  assert.deepEqual(within([inside, edge], window), [inside], "the end is exclusive");
});

test("Misses read the latest run's searches when the window has them", () => {
  assert.equal(
    chooseSource(["reranker-shadow", "ratel:search-telemetry"], "ratel:search-telemetry"),
    "ratel:search-telemetry",
  );
  assert.equal(
    chooseSource(["reranker-shadow", "ratel:search-telemetry"], null),
    "reranker-shadow",
    "no run: busiest calibration first",
  );
  assert.equal(
    chooseSource(["ratel:search-telemetry"], "old-calibration"),
    "ratel:search-telemetry",
  );
  assert.equal(chooseSource([], "ratel:search-telemetry"), null);
});

test("ours is the only engine, the run's tuned arm, or the one that is not the baseline", () => {
  const single = [selection()];
  assert.equal(resolveOurArm(single, "ratel:search-telemetry", null), "ratel");
  const paired = [selection({ theirs: ["x"] }), selection({ theirs: ["y"] })];
  assert.equal(
    resolveOurArm(paired, "cal", {
      experimentName: "cal",
      tunedArm: "legacy",
      baselineArm: "ratel",
    }),
    "legacy",
    "the run read this experiment, so its tuned arm stands",
  );
  assert.equal(resolveOurArm(paired, "cal", null), "ratel", "legacy is named as the baseline");
  assert.equal(resolveOurArm([], "cal", null), null);
});

test("another experiment's run never decides which arm is ours here", () => {
  const paired = [selection({ theirs: ["x"] }), selection({ theirs: ["y"] })];
  const elsewhere = {
    experimentName: "other-experiment",
    tunedArm: "legacy",
    baselineArm: "ratel",
  };
  assert.equal(
    resolveOurArm(paired, "cal", elsewhere),
    "ratel",
    "its baseline would make the incumbent ours; this experiment's own names decide",
  );
});

test("a cut read is flagged only when it reached this window", () => {
  const window = { since: new Date(END.getTime() - 7 * DAY), until: END };
  const at = (daysAgo: number) => ({ occurredAt: new Date(END.getTime() - daysAgo * DAY) });
  assert.equal(windowCut(false, [at(1)], window), false);
  assert.equal(
    windowCut(true, [at(10), at(1)], window),
    false,
    "the cut fell in the window before",
  );
  assert.equal(
    windowCut(true, [at(3), at(1)], window),
    true,
    "the oldest kept search is inside this window",
  );
  assert.equal(windowCut(true, [], window), true);
});

test("each right tool's searches: first, found and missed, for its description's card", () => {
  const tallies = toolTallies([
    { target: "a", rank: 1 },
    { target: "a", rank: 3 },
    { target: "a", rank: null },
    { target: "b", rank: 1 },
  ]);
  assert.deepEqual(tallies, {
    a: { searches: 3, first: 1, found: 2 },
    b: { searches: 1, first: 1, found: 1 },
  });
});

test("an outcome is first, lower or missing", () => {
  assert.equal(outcomeOf(1), "first");
  assert.equal(outcomeOf(4), "lower");
  assert.equal(outcomeOf(null), "missing");
});
