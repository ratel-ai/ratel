import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RING_CELLS,
  ringCells,
  scoreCopy,
} from "@/components/console/health/v2/health-score-model";
import {
  gainOf,
  HARM_CAP,
  HARM_WEIGHT,
  HEALTH_SCORE_VERSION,
  healthBand,
  healthScore,
  healthScoreView,
  ISSUE_HARM,
  issueHarm,
  parseStoredHealthScore,
  type ScoredIssue,
  scoredIssues,
  scoreGain,
} from "@/lib/readings/trace-signals/health-score";
import { SIGNAL_KINDS } from "@/lib/readings/trace-signals/view";

const issue = (
  id: string,
  kind: ScoredIssue["kind"],
  turns: number,
  severity = 0.5,
): ScoredIssue => ({ id, kind, turns, severity });

test("every kind of issue has a harm, and the harms rank breaks > misleads > wastes > tidies", () => {
  for (const kind of SIGNAL_KINDS) assert.ok(ISSUE_HARM[kind], kind);
  assert.ok(
    HARM_WEIGHT.breaks > HARM_WEIGHT.misleads &&
      HARM_WEIGHT.misleads > HARM_WEIGHT.wastes &&
      HARM_WEIGHT.wastes > HARM_WEIGHT.tidies,
  );
  assert.ok(
    HARM_CAP.breaks > HARM_CAP.misleads &&
      HARM_CAP.misleads > HARM_CAP.wastes &&
      HARM_CAP.wastes > HARM_CAP.tidies,
  );
});

test("an issue's harm is its reach times its level's weight: turns it touches, else its severity", () => {
  assert.equal(
    issueHarm(issue("a", "error_loop", 100), 1_000),
    0.1,
    "a tenth of turns, breaking them",
  );
  assert.equal(issueHarm(issue("a", "padding_share", 100), 1_000), 0.1 * HARM_WEIGHT.wastes);
  assert.equal(
    issueHarm(issue("a", "dead_tool", 0, 0.2), 1_000),
    0.2 * HARM_WEIGHT.tidies,
    "no turns: its severity is its reach",
  );
  assert.equal(
    issueHarm(issue("a", "error_loop", 5_000), 1_000),
    1,
    "reach never passes every turn",
  );
});

test("no issues is 100; kinds combine like a turn getting through each, each kind capped by its level", () => {
  assert.equal(healthScore([], 1_000), 100);
  assert.equal(healthScore([issue("a", "error_loop", 100)], 1_000), 90);
  // 0.9 × (1 − 0.06) = 0.846
  assert.equal(
    healthScore([issue("a", "error_loop", 100), issue("b", "first_try_miss", 100)], 1_000),
    85,
  );
  assert.equal(
    healthScore([issue("a", "error_loop", 900)], 1_000),
    100 - HARM_CAP.breaks * 100,
    "one kind never decides the score alone",
  );
  assert.equal(
    healthScore([issue("a", "padding_share", 1_000)], 1_000),
    100 - HARM_CAP.wastes * 100,
    "waste on every turn costs at most its cap",
  );
  // Twenty chains are one thing to tidy: together they cost at most the tidy cap.
  const chains = Array.from({ length: 20 }, (_, i) => issue(`c${i}`, "sequence_chain", 300));
  assert.equal(healthScore(chains, 1_000), 100 - HARM_CAP.tidies * 100);
  // Every kind at its worst still leaves a number, never below 0.
  const worst = (Object.keys(ISSUE_HARM) as ScoredIssue["kind"][]).map((kind) =>
    issue(kind, kind, 1_000, 1),
  );
  const floor = healthScore(worst, 1_000);
  assert.ok(floor >= 0 && floor < 10, `everything at once is struggling (${floor})`);
});

test("what fixing issues wins back is exact: the score without them, minus the score now", () => {
  const issues = [
    issue("a", "error_loop", 100),
    issue("b", "first_try_miss", 100),
    issue("c", "padding_share", 300),
    issue("d", "sequence_chain", 400),
    issue("e", "sequence_chain", 400),
  ];
  const now = healthScore(issues, 1_000);
  const view = healthScoreView(issues, 1_000);
  assert.equal(view.value, now);
  for (const ids of [
    ["a"],
    ["b"],
    ["c"],
    ["d"],
    ["d", "e"],
    ["a", "c"],
    ["a", "b", "c", "d", "e"],
  ]) {
    assert.equal(
      gainOf(view, ids),
      healthScore(
        issues.filter((i) => !ids.includes(i.id)),
        1_000,
      ) - now,
      ids.join("+"),
    );
    assert.equal(scoreGain(issues, 1_000, new Set(ids)), gainOf(view, ids));
  }
  assert.equal(
    gainOf(view, ["a", "b", "c", "d", "e"]),
    100 - now,
    "fixing everything is a full score",
  );
  assert.equal(gainOf(view, ["unknown"]), 0);
  assert.equal(view.issues, 4, "four kinds of issue");
  assert.equal(
    view.topGain,
    gainOf(view, ["a", "b", "c"]),
    "the top three kinds: errors, misses, padding",
  );
});

test("the change is against the previous reading of this version only, and the trend ends now", () => {
  const issues = [issue("a", "error_loop", 100)];
  const view = healthScoreView(issues, 1_000, [
    { version: HEALTH_SCORE_VERSION, value: 84 },
    { version: HEALTH_SCORE_VERSION + 1, value: 10 },
    { version: HEALTH_SCORE_VERSION, value: 80 },
  ]);
  assert.equal(view.value, 90);
  assert.equal(view.change, 6);
  assert.deepEqual(view.trend, [80, 84, 90]);
  assert.equal(healthScoreView(issues, 1_000).change, null);
  assert.deepEqual(healthScoreView(issues, 1_000).trend, [90]);
});

test("bands and the stored score parse", () => {
  assert.deepEqual([95, 90, 89, 75, 74, 50, 49, 0].map(healthBand), [
    "healthy",
    "healthy",
    "good",
    "good",
    "needs_work",
    "needs_work",
    "struggling",
    "struggling",
  ]);
  assert.deepEqual(parseStoredHealthScore({ version: 1, value: 72 }), { version: 1, value: 72 });
  assert.equal(parseStoredHealthScore({ value: 72 }), null);
  assert.equal(parseStoredHealthScore(null), null);
  assert.equal(parseStoredHealthScore({ version: 1, value: Number.NaN }), null);
});

test("the score's words: band, headline, the goal three fixes reach, change, where the points go", () => {
  const issues = [
    issue("a", "error_loop", 100),
    issue("b", "first_try_miss", 100),
    issue("c", "padding_share", 300),
    issue("d", "dead_tool", 0, 0.1),
  ];
  const view = healthScoreView(issues, 1_000, [{ version: HEALTH_SCORE_VERSION, value: 70 }]);
  const copy = scoreCopy(view);
  assert.equal(copy.band, "Good");
  assert.equal(copy.tone, "success");
  assert.equal(copy.headline, "Your agent is doing well.");
  assert.deepEqual(copy.change, {
    text: `+${view.value - 70} since the last reading`,
    direction: "up",
  });
  assert.equal(copy.target, view.value + view.topGain);
  assert.equal(copy.goal, `Fix the top 3 issues to reach ${copy.target}.`);
  assert.equal(copy.goalLead, "Fix the top 3 issues to reach");
  assert.deepEqual(
    copy.lost.map((part) => part.label),
    ["Failing turns", "Wrong tool first", "Wasted calls and time", "Tidying"],
  );
  assert.equal(
    copy.lost.reduce((sum, part) => sum + part.points, 0),
    100 - view.value,
  );

  const down = scoreCopy(
    healthScoreView(issues, 1_000, [{ version: HEALTH_SCORE_VERSION, value: 99 }]),
  );
  assert.equal(down.change?.direction, "down");
  assert.match(down.change?.text ?? "", /^-\d+ since the last reading$/);
  assert.equal(
    scoreCopy(healthScoreView([], 1_000, [{ version: HEALTH_SCORE_VERSION, value: 100 }])).change
      ?.text,
    "No change since the last reading",
  );
  const clean = scoreCopy(healthScoreView([], 1_000));
  assert.equal(clean.goal, "No open issues in this reading.");
  assert.equal(clean.headline, "Your agent is in great shape.");
  assert.deepEqual(clean.lost, []);
  assert.equal(
    scoreCopy(healthScoreView([issue("a", "error_loop", 100)], 1_000)).goal,
    "Fix the open issue to reach 100.",
  );
  assert.equal(
    scoreCopy(healthScoreView([issue("a", "dead_tool", 0, 0.01)], 1_000)).goal,
    "What is open costs less than a point.",
  );
  const failing = Array.from({ length: 6 }, (_, i) =>
    issue(
      `f${i}`,
      (
        [
          "error_loop",
          "identical_retry",
          "unknown_tool",
          "empty_result",
          "blocked_action",
          "agent_failing",
        ] as const
      )[i]!,
      400,
    ),
  );
  assert.equal(scoreCopy(healthScoreView(failing, 1_000)).headline, "Your agent is struggling.");
  for (const c of [copy, down]) assert.doesNotMatch(JSON.stringify(c), /\u2014/);
});

test("the ring lights the score clockwise, its tip coral, the pixels three fixes reach faint", () => {
  const cells = ringCells(50, 75);
  assert.equal(cells.length, RING_CELLS);
  const count = (state: string) => cells.filter((cell) => cell.state === state).length;
  assert.equal(count("lit") + count("tip"), RING_CELLS / 2);
  assert.equal(count("tip"), 1);
  assert.equal(count("target"), RING_CELLS * 0.75 - RING_CELLS / 2);
  assert.equal(
    cells.findIndex((cell) => cell.state === "tip"),
    RING_CELLS / 2 - 1,
    "the tip ends the lit run",
  );
  assert.ok(cells[0]!.x < 100 && cells[0]!.y > 100, "it starts bottom left");
  assert.ok(
    cells.at(-1)!.x > 100 && cells.at(-1)!.y > 100,
    "and ends bottom right, open at the bottom",
  );
  assert.equal(
    ringCells(0, null).every((cell) => cell.state === "off"),
    true,
  );
  assert.equal(ringCells(100, null).filter((cell) => cell.state === "off").length, 0);
});

test("the missing points split by level and add up to exactly what is missing", () => {
  const issues = [
    issue("a", "error_loop", 100),
    issue("b", "first_try_miss", 100),
    issue("c", "padding_share", 300),
    issue("d", "sequence_chain", 400),
  ];
  const view = healthScoreView(issues, 1_000);
  const sum = Object.values(view.lost).reduce((a, b) => a + b, 0);
  assert.equal(sum, 100 - view.value);
  assert.ok(
    view.lost.breaks > view.lost.misleads,
    "a tenth of turns failing costs more than a tenth misled",
  );
  assert.ok(view.lost.tidies <= HARM_CAP.tidies * 100);
  assert.deepEqual(healthScoreView([], 1_000).lost, {
    breaks: 0,
    misleads: 0,
    wastes: 0,
    tidies: 0,
  });
  // One level alone takes all of it.
  assert.deepEqual(healthScoreView([issue("a", "error_loop", 100)], 1_000).lost, {
    breaks: 10,
    misleads: 0,
    wastes: 0,
    tidies: 0,
  });
});

test("an unknown_tool whose calls ran is not a failing turn; one the catalog alone vouches for still is", () => {
  const record = (id: string, kind: ScoredIssue["kind"], metrics: Record<string, unknown>) => ({
    id,
    kind,
    severity: 0.5,
    totalTurns: 10,
    metrics,
  });
  const issues = scoredIssues([
    record("ran", "unknown_tool", { toolStanding: "succeeded" }),
    record("catalog", "unknown_tool", { toolStanding: "in_catalog" }),
    record("missing", "unknown_tool", {}),
    record("other", "error_loop", { toolStanding: "succeeded" }),
  ]);
  assert.deepEqual(
    issues.map((i) => i.id),
    ["catalog", "missing", "other"],
  );
});
