import assert from "node:assert/strict";
import { test } from "node:test";
import {
  comparisonColumns,
  type KindById,
  type RecordedArm,
  reproducesShadow,
  reproductionVerdict,
  sameQuery,
  unresolvedIds,
} from "./calibration-compare";
import { RANKED_HIT_DEFAULTS } from "./test-support";
import type { CapabilityKind, RankedBuckets, RankedHit } from "./types";

const KINDS: KindById = new Map<string, CapabilityKind>([
  ["deploy-service", "skill"],
  ["review-pull-request", "skill"],
  ["write-unit-tests", "skill"],
  ["flaky_deploy_api", "tool"],
  ["github_api", "tool"],
  ["ripgrep", "tool"],
]);

function hit(id: string, rank: number): RankedHit {
  return {
    ...RANKED_HIT_DEFAULTS,
    id,
    kind: KINDS.get(id) === "tool" ? "tool" : "skill",
    rank,
    score: 1 / rank,
    bm25Score: 1 / rank,
    embeddingScore: null,
    description: `${id} description`,
    edited: false,
  };
}

function buckets(skills: string[], tools: string[]): RankedBuckets {
  return {
    skills: skills.map((id, index) => hit(id, index + 1)),
    tools: tools.map((id, index) => hit(id, index + 1)),
  };
}

const ARMS: RecordedArm[] = [
  {
    arm: "control",
    role: "served",
    resultIds: ["deploy-service", "github_api", "flaky_deploy_api"],
  },
  {
    arm: "shadow",
    role: "shadow",
    resultIds: ["deploy-service", "flaky_deploy_api", "github_api"],
  },
];

test("an arm's mixed list is split by kind, never ordered across buckets", () => {
  // The engine ranks the two buckets independently because BM25 scores over the
  // two text shapes are not comparable. A column that interleaved them would
  // imply an ordering nothing computed.
  const skills = comparisonColumns({
    arms: ARMS,
    saved: buckets(["deploy-service"], ["flaky_deploy_api"]),
    edited: null,
    kind: "skill",
    kindById: KINDS,
  });
  const tools = comparisonColumns({
    arms: ARMS,
    saved: buckets(["deploy-service"], ["flaky_deploy_api"]),
    edited: null,
    kind: "tool",
    kindById: KINDS,
  });

  assert.deepEqual(
    skills[0].rows.map((row) => row.id),
    ["deploy-service"],
  );
  // Renumbered WITHIN the bucket: github_api was recorded second overall but is
  // the first tool, and a column that showed it as rank 2 with no rank 1 above
  // it would look like a missing row.
  assert.deepEqual(
    tools[0].rows.map((row) => ({ id: row.id, rank: row.rank })),
    [
      { id: "github_api", rank: 1 },
      { id: "flaky_deploy_api", rank: 2 },
    ],
  );
});

test("each column diffs against the one to its left, not a shared baseline", () => {
  const columns = comparisonColumns({
    arms: ARMS,
    saved: buckets([], ["github_api", "flaky_deploy_api"]),
    edited: buckets([], ["flaky_deploy_api", "github_api"]),
    kind: "tool",
    kindById: KINDS,
  });

  assert.deepEqual(
    columns.map((column) => column.key),
    ["served", "shadow", "now", "edited"],
  );
  // The first column has nothing to its left, so nothing to report.
  assert.ok(columns[0].rows.every((row) => row.change === null));

  // served tools: github_api, flaky_deploy_api → shadow tools: flaky, github.
  assert.deepEqual(
    columns[1].rows.map((row) => [row.id, row.change]),
    [
      ["flaky_deploy_api", "up"],
      ["github_api", "down"],
    ],
  );
  assert.equal(columns[1].changed, 2);

  // The live run went back to the served order, which is a change against
  // SHADOW (the column on its left), not against served.
  assert.deepEqual(
    columns[2].rows.map((row) => [row.id, row.change]),
    [
      ["github_api", "up"],
      ["flaky_deploy_api", "down"],
    ],
  );

  // The edit put it back again, reported against the live run.
  assert.deepEqual(
    columns[3].rows.map((row) => [row.id, row.change]),
    [
      ["flaky_deploy_api", "up"],
      ["github_api", "down"],
    ],
  );
});

test("a capability the previous column did not have reads as new", () => {
  const columns = comparisonColumns({
    arms: ARMS,
    saved: buckets([], ["ripgrep", "github_api", "flaky_deploy_api"]),
    edited: null,
    kind: "tool",
    kindById: KINDS,
  });
  const now = columns[2];
  assert.equal(now.rows.find((row) => row.id === "ripgrep")?.change, "new");
});

test("the edited column is omitted when nothing is edited", () => {
  const columns = comparisonColumns({
    arms: ARMS,
    saved: buckets(["deploy-service"], []),
    edited: null,
    kind: "skill",
    kindById: KINDS,
  });
  assert.deepEqual(
    columns.map((column) => column.key),
    ["served", "shadow", "now"],
  );
});

test("recorded ids that left the catalog are surfaced, not silently dropped", () => {
  // Dropping them would make the recorded arm look shorter than it was, and
  // "that capability is gone" is one of the better explanations for a mismatch
  // nothing else reproduces.
  const arms: RecordedArm[] = [
    { arm: "control", role: "served", resultIds: ["deploy-service", "retired"] },
    { arm: "shadow", role: "shadow", resultIds: ["retired", "also-gone"] },
  ];
  assert.deepEqual(unresolvedIds(arms, KINDS).sort(), ["also-gone", "retired"]);
  assert.deepEqual(unresolvedIds(ARMS, KINDS), []);
});

test("reproducesShadow reports what the live run still returns, in order", () => {
  const exact = reproducesShadow(
    ARMS,
    buckets(["deploy-service"], ["flaky_deploy_api", "github_api"]),
  );
  assert.deepEqual(exact, { recorded: 3, matched: 3, sameOrder: true });

  // Same three, different order: reproduced but not identically.
  const reordered = reproducesShadow(
    ARMS,
    buckets(["deploy-service"], ["github_api", "flaky_deploy_api"]),
  );
  assert.equal(reordered?.matched, 3);
  assert.equal(reordered?.sameOrder, false);

  const lost = reproducesShadow(ARMS, buckets(["deploy-service"], []));
  assert.deepEqual(lost, { recorded: 3, matched: 1, sameOrder: false });
});

test("reproducesShadow ignores live results the arm had no room to return", () => {
  // The live run has its own top-K. Counting an extra live hit as drift would
  // report a difference that is an artifact of the budget, not of the catalog.
  const result = reproducesShadow(
    ARMS,
    buckets(
      ["deploy-service", "review-pull-request"],
      ["flaky_deploy_api", "github_api", "ripgrep"],
    ),
  );
  assert.deepEqual(result, { recorded: 3, matched: 3, sameOrder: true });
});

test("reproducesShadow has nothing to say without a shadow arm's results", () => {
  assert.equal(reproducesShadow([], buckets([], [])), null);
  assert.equal(
    reproducesShadow(
      [{ arm: "shadow", role: "shadow", resultIds: [] }],
      buckets(["deploy-service"], []),
    ),
    null,
  );
});

test("sameQuery ignores case and surrounding whitespace only", () => {
  assert.equal(sameQuery("Deploy The Service ", "deploy the service"), true);
  assert.equal(sameQuery("deploy the service", "deploy a service"), false);
});

test("reproductionVerdict separates reordered from genuinely lost", () => {
  // Flattening these to "matches / does not match" would hide the one that
  // actually matters: only a missing result makes an edit untestable here.
  assert.equal(reproductionVerdict({ recorded: 3, matched: 3, sameOrder: true }).ok, true);

  const reordered = reproductionVerdict({
    recorded: 3,
    matched: 3,
    sameOrder: false,
  });
  assert.equal(reordered.ok, false);
  assert.equal(reordered.label, "ranked differently since");

  const lost = reproductionVerdict({ recorded: 3, matched: 1, sameOrder: false });
  assert.equal(lost.ok, false);
  assert.equal(lost.label, "your catalog changed since");
});

test("an identical shadow column is folded into the live one", () => {
  // Two columns holding the same list in the same order is not a comparison,
  // it is the same answer printed twice, and that is the state a healthy
  // project is in almost all of the time.
  const columns = comparisonColumns({
    arms: ARMS,
    saved: buckets(["deploy-service"], ["flaky_deploy_api", "github_api"]),
    edited: null,
    kind: "tool",
    kindById: KINDS,
    collapseShadow: true,
  });

  assert.deepEqual(
    columns.map((column) => column.key),
    ["served", "now"],
  );
  // Marked, so "where did shadow go" is answered in place rather than by
  // remembering what the banner said.
  assert.equal(columns[1].mergedShadow, true);
  // And the movement is now measured against SERVED, the column to its left.
  assert.deepEqual(
    columns[1].rows.map((row) => [row.id, row.change]),
    [
      ["flaky_deploy_api", "up"],
      ["github_api", "down"],
    ],
  );
});

test("collapsing is off by default, so a drifted catalog keeps both columns", () => {
  const columns = comparisonColumns({
    arms: ARMS,
    saved: buckets([], ["github_api"]),
    edited: null,
    kind: "tool",
    kindById: KINDS,
  });
  assert.deepEqual(
    columns.map((column) => column.key),
    ["served", "shadow", "now"],
  );
  assert.equal(columns[2].mergedShadow, undefined);
});

test("scores normalize within their own column, never across columns", () => {
  // Two arms can be different engine configurations, and BM25 is
  // corpus-relative even within one, so a bar drawn to a shared scale would
  // compare numbers that are not comparable.
  const columns = comparisonColumns({
    arms: [
      {
        arm: "control",
        role: "served",
        resultIds: ["github_api", "ripgrep"],
        resultScores: [8, 2],
      },
    ],
    saved: {
      skills: [],
      tools: [hit("github_api", 1), hit("ripgrep", 2)],
    },
    edited: null,
    kind: "tool",
    kindById: KINDS,
  });

  // Recorded: 8 and 2 → the leader fills, the other is a quarter of it.
  assert.deepEqual(
    columns[0].rows.map((row) => [row.score, row.fill]),
    [
      [8, 1],
      [2, 0.25],
    ],
  );
  // Live: 1 and 0.5 from the fixture, on their own scale rather than the
  // recorded one, which would have drawn them as slivers.
  assert.equal(columns[1].rows[0].fill, 1);
  assert.equal(columns[1].rows[1].fill, 0.5);
});

test("a row with no recorded score gets no bar rather than a full one", () => {
  const columns = comparisonColumns({
    arms: [{ arm: "control", role: "served", resultIds: ["github_api"] }],
    saved: { skills: [], tools: [] },
    edited: null,
    kind: "tool",
    kindById: KINDS,
  });
  assert.equal(columns[0].rows[0].score, null);
  assert.equal(columns[0].rows[0].fill, 0);
});
