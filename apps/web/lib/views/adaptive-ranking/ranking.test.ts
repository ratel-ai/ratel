import assert from "node:assert/strict";
import { test } from "node:test";
import type { EvaluableSelection } from "@/lib/synthesis/quality/ground-truth";
import { buildBoostView } from "@/lib/views/adaptive-ranking/boost-view";
import {
  graphGrowth,
  percentDomain,
  rankingChecklist,
  rankingCurve,
  rankingHeadline,
  rankingMetrics,
  servingState,
} from "@/lib/views/adaptive-ranking/ranking";

test("the chart's axis fits the curves on round steps", () => {
  const domain = percentDomain([0.62, 0.71, 0.81, null]);
  assert.deepEqual(domain, {
    low: 0.55,
    high: 0.85,
    ticks: [0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85],
  });
  assert.deepEqual(percentDomain([0.1, 0.95]).ticks, [0, 0.25, 0.5, 0.75, 1]);
  assert.deepEqual(percentDomain([]), { low: 0, high: 1, ticks: [0, 0.25, 0.5, 0.75, 1] });
  const flat = percentDomain([1, 1]);
  assert.equal(flat.high, 1, "never past 100%");
  assert.ok(flat.low < 1);
});

test("the checklist marks the first open step as the one to do now", () => {
  const steps = rankingChecklist([
    { key: "events", label: "Events arriving", detail: "a", state: "done" },
    { key: "building", label: "Graph building", detail: "b", state: "pending" },
    {
      key: "connected",
      label: "Runtime connected",
      detail: "c",
      state: "pending",
      snippet: "attach()",
    },
    { key: "following", label: "Runtime following updates", detail: "d", state: "pending" },
  ]);
  assert.deepEqual(
    steps.map((step) => [step.key, step.state]),
    [
      ["events", "done"],
      ["building", "current"],
      ["connected", "todo"],
      ["following", "todo"],
    ],
  );
  assert.equal(steps[2]!.snippet, "attach()");
  const broken = rankingChecklist([
    { key: "events", label: "Events arriving", detail: "a", state: "problem" },
    { key: "building", label: "Graph building", detail: "b", state: "pending" },
  ]);
  assert.deepEqual(
    broken.map((step) => step.state),
    ["problem", "todo"],
    "a problem is the step to fix now",
  );
});

/** Shadow turns as Cloud stores them: the plain list served, the graph's list beside it. */
function turns(
  count: number,
  plainFirst: (index: number) => boolean,
  graphFirst: (index: number) => boolean,
): EvaluableSelection[] {
  return Array.from({ length: count }, (_, index) => ({
    selectionId: `s-${index}`,
    occurredAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index)),
    query: null,
    arms: [
      {
        arm: "baseline",
        role: "serving" as const,
        resultIds: plainFirst(index) ? ["right", "other"] : ["other", "right"],
      },
      {
        arm: "adaptive",
        role: "shadow" as const,
        resultIds: graphFirst(index) ? ["right", "other"] : ["other", "right"],
      },
    ],
    invokedToolId: "right",
    invokedRank: null,
  }));
}

test("the headline is the relative change in how often the right tool comes first, once the intervals separate", () => {
  // 400 searches: right first 70% of the time without the graph, 80% with it.
  const view = buildBoostView(
    turns(
      400,
      (i) => i % 10 < 7,
      (i) => i % 10 < 8,
    ),
    { estimated: true },
  );
  const projected = rankingHeadline(view, false);
  assert.equal(projected.state, "better");
  assert.equal(projected.searches, 400);
  assert.equal(Math.round((projected.relative ?? 0) * 100), 14);
  assert.equal(projected.points, 10);
  assert.ok(
    projected.intervals!.withGraph.low > projected.intervals!.without.high,
    "the two intervals separate",
  );
  assert.equal(
    projected.title,
    "Would find the right tool first 14% more often",
    "not served: what it would do",
  );
  assert.equal(
    projected.detail,
    "With adaptive ranking the right tool would have come first on 80% of 400 searches that reported the tool the agent ran, against 70% without it.",
  );
  assert.equal(projected.estimated, true);
  assert.deepEqual(projected.notes, [
    "Estimated by replaying your searches on Ratel's keyword index, with and without the graph as it stood at each search. Your runtime's own ranking may differ.",
  ]);
  assert.equal(projected.upperBound, false, "the agent chose from the plain list");
  assert.doesNotMatch(projected.title + projected.detail, /recall|ndcg|mrr|@/i, "plain words only");
  assert.equal(rankingHeadline(view, true).title, "Finds the right tool first 14% more often");
});

test("a gap within chance is about as often, whatever its size", () => {
  // The same 80% against 70%, over 100 searches: the intervals overlap.
  const thin = rankingHeadline(
    buildBoostView(
      turns(
        100,
        (i) => i % 10 < 7,
        (i) => i % 10 < 8,
      ),
    ),
    false,
  );
  assert.equal(thin.state, "same");
  assert.equal(thin.title, "Would find the right tool first about as often as without it");
  assert.match(thin.detail, /within what chance alone gives/);
  assert.equal(
    rankingHeadline(
      buildBoostView(
        turns(
          50,
          () => true,
          (i) => i < 40,
        ),
      ),
      true,
    ).title,
    "Finds the right tool first 20% less often",
  );
});

test("a zero baseline reads as the two shares, never as 100% more often", () => {
  const view = buildBoostView(
    turns(
      60,
      () => false,
      (i) => i % 2 === 0,
    ),
  );
  const headline = rankingHeadline(view, false);
  assert.equal(headline.state, "better");
  assert.equal(headline.relative, null);
  assert.equal(headline.points, 50);
  assert.equal(
    headline.title,
    "Would put the right tool first on 50% of searches, up from none without it",
  );
  assert.doesNotMatch(headline.title, /100%/);
  const never = rankingHeadline(
    buildBoostView(
      turns(
        60,
        (i) => i % 2 === 0,
        () => false,
      ),
    ),
    true,
  );
  assert.equal(never.title, "Never puts the right tool first, against 50% of searches without it");
});

test("only searches that reported the tool the agent ran are scored, and too few or none say so", () => {
  // 40 searches, of which only 30 reported a tool call: the other 10 are left out of both shares.
  const mixed = [
    ...turns(
      30,
      (i) => i < 15,
      () => true,
    ),
    ...turns(
      10,
      () => false,
      () => false,
    ).map((selection, index) => ({ ...selection, selectionId: `r-${index}`, invokedToolId: null })),
  ];
  const view = buildBoostView(mixed);
  const headline = rankingHeadline(view, false);
  assert.equal(headline.searches, 30);
  assert.equal(headline.seen, 40);
  assert.equal(headline.withGraph, 1);
  assert.equal(headline.without, 0.5);
  assert.deepEqual(
    rankingMetrics(view).find((metric) => metric.id === "recall@1"),
    { id: "recall@1", without: 0.5, withGraph: 1 },
    "Details read the same searches",
  );

  const few = rankingHeadline(
    buildBoostView(
      turns(
        4,
        () => true,
        () => true,
      ),
    ),
    false,
  );
  assert.equal(few.state, "none");
  assert.equal(few.withGraph, null);
  assert.equal(
    few.detail,
    "4 of the 10 searches the comparison needs have reported the tool the agent ran. It fills in as traffic arrives.",
  );
  assert.equal(rankingHeadline(buildBoostView([]), false).state, "none");

  const untied = turns(
    25,
    () => true,
    () => true,
  ).map((selection) => ({ ...selection, invokedToolId: null }));
  const unscored = rankingHeadline(buildBoostView(untied), false);
  assert.equal(unscored.state, "unscored");
  assert.equal(unscored.title, "None of the 25 searches reported the tool the agent ran");
  assert.match(unscored.detail, /search_id/);
});

test("when the agent picked from the graph's own list, the share with it is an upper bound", () => {
  const served = turns(
    50,
    () => true,
    () => true,
  ).map((selection) => ({
    ...selection,
    arms: [
      { ...selection.arms[0]!, role: "shadow" as const },
      { ...selection.arms[1]!, role: "serving" as const },
    ],
  }));
  const headline = rankingHeadline(buildBoostView(served), true);
  assert.equal(headline.upperBound, true);
  assert.match(headline.notes.join(" "), /upper bound/);
});

test("the curve starts once the running share means something and keeps its last point", () => {
  const view = buildBoostView(
    turns(
      400,
      (i) => i % 10 < 7,
      (i) => i % 10 < 8,
    ),
  );
  const curve = rankingCurve(view, 50);
  assert.equal(curve.length, 50);
  assert.equal(curve[0]!.turn, 10);
  assert.equal(curve.at(-1)!.turn, 400);
  assert.ok(Math.abs((curve.at(-1)!.withGraph ?? 0) - 0.8) < 1e-9);
  assert.ok(Math.abs((curve.at(-1)!.without ?? 0) - 0.7) < 1e-9);
  assert.equal(
    rankingCurve(
      buildBoostView(
        turns(
          30,
          () => true,
          () => true,
        ),
      ),
    ).length,
    21,
    "short runs are drawn whole",
  );
});

test("serving reads as words, never as watching or boosting", () => {
  assert.deepEqual(
    [
      servingState("cloud", "watching").label,
      servingState("cloud", "live").label,
      servingState("cloud", "boosting").label,
    ],
    ["Not served yet", "Served", "Served"],
  );
  assert.equal(servingState("cloud", null).served, false);
  assert.equal(servingState("runtime", null).served, true);
  for (const state of [servingState("cloud", "watching"), servingState("cloud", "boosting")]) {
    assert.doesNotMatch(state.sentence, /watching|boosting|shadow|arm/i);
  }
});

test("growth is how much has been learned and how much room is used", () => {
  assert.deepEqual(graphGrowth({ maturity: 0.82, clusterCount: 30, byteSize: 11_602 }), {
    learned: 0.82,
    used: 30 / 5000,
    usedLabel: "30 of 5,000 ask groups",
  });
  assert.equal(
    graphGrowth({ maturity: Number.NaN, clusterCount: 0, byteSize: 3_000_000 }).used,
    0.75,
    "size can be the tighter budget",
  );
  assert.equal(graphGrowth({ maturity: 4, clusterCount: 0, byteSize: 0 }).learned, 1);
});
