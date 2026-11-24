import assert from "node:assert/strict";
import { test } from "node:test";
import type { PillarReading } from "@/lib/readings/trace-signals/health-pillars";
import { healthScoreView, scoredIssues } from "@/lib/readings/trace-signals/health-score";
import type { SignalKind, SignalView } from "@/lib/readings/trace-signals/view";
import { type IssueCategory, issueCategories } from "@/lib/views/health/issue-categories";
import { issueRows } from "@/lib/views/health/issue-rows";
import { signal } from "@/lib/views/health/workflows-view-fixtures";

const sig = (id: string, kind: SignalKind, totalTurns: number): SignalView => ({
  ...signal(id, kind, "tool", `tool_${id}`, [`tool_${id}`]),
  evidence: { chart: null, turns: [], totalTurns },
});

function read(
  signals: readonly SignalView[],
  {
    tooEarly = [],
    pillars = [],
    scored = true,
    metrics = {},
  }: {
    tooEarly?: readonly SignalView[];
    pillars?: readonly PillarReading[];
    scored?: boolean;
    metrics?: Readonly<Record<string, unknown>>;
  } = {},
) {
  const score = scored
    ? healthScoreView(
        scoredIssues(
          signals.map(({ evidence, ...rest }) => ({
            ...rest,
            totalTurns: evidence.totalTurns,
            metrics,
          })),
        ),
        100,
        [],
        pillars,
      )
    : null;
  const rows = issueRows({ projectId: "p1", signals, tooEarly, tasks: [], fixes: [], score });
  return { score, rows, categories: issueCategories(rows, score) };
}

const brief = (categories: readonly IssueCategory[]) =>
  categories.map((c) => [c.level, c.lost, c.rows.map((row) => row.kind), c.issues, c.healthy]);

test("each issue is in its level, worst level first, and the lost points are the score's", () => {
  const { score, categories } = read(
    [sig("b", "long_turn", 20), sig("a", "error_loop", 20), sig("c", "unused_tool", 0)].map((s) =>
      s.kind === "unused_tool" ? { ...s, severity: 0 } : s,
    ),
  );
  assert.equal(score?.value, 76);
  assert.deepEqual(brief(categories), [
    ["breaks", 20, ["error_loop"], 1, false],
    ["misleads", 0, [], 0, true],
    ["wastes", 4, ["long_turn"], 1, false],
    ["tidies", 0, ["unused_tool"], 1, false],
  ]);
  assert.deepEqual(
    categories.map((c) => c.label),
    ["Failing turns", "Detours and corrections", "Wasted calls and time", "Tidying"],
  );
});

test("inside a level the rows keep their order: most points first", () => {
  const { categories } = read([sig("a", "empty_result", 5), sig("b", "error_loop", 25)]);
  assert.deepEqual(
    categories[0]?.rows.map((row) => row.kind),
    ["error_loop", "empty_result"],
  );
});

test("no issues: every category is healthy", () => {
  const { categories } = read([]);
  assert.deepEqual(brief(categories), [
    ["breaks", 0, [], 0, true],
    ["misleads", 0, [], 0, true],
    ["wastes", 0, [], 0, true],
    ["tidies", 0, [], 0, true],
  ]);
});

test("a measured rate loses points in its own level, with no issue", () => {
  const { score, categories } = read([], {
    pillars: [{ pillar: "ended", good: 0.8, n: 100 }],
  });
  assert.equal(score?.value, 88);
  assert.deepEqual(brief(categories)[0], ["breaks", 12, [], 0, false]);
  assert.deepEqual(categories[0]?.rates, [
    { pillar: "ended", label: "Runs end well", good: 0.8, n: 100 },
  ]);
});

test("every measured rate is in its level", () => {
  const pillars: PillarReading[] = [
    { pillar: "ended", good: 1, n: 50 },
    { pillar: "top_5", good: 1, n: 50 },
    { pillar: "corrections", good: 1, n: 50 },
    { pillar: "tasks", good: 1, n: 50 },
    { pillar: "calls", good: 1, n: 50 },
  ];
  assert.deepEqual(
    read([], { pillars }).categories.map((c) => c.rates.map((rate) => rate.pillar)),
    [["ended", "tasks"], ["top_5", "corrections"], ["calls"], []],
  );
});

test("no score: the rows still group, with no points and no rates", () => {
  const { categories } = read([sig("a", "error_loop", 20)], { scored: false });
  assert.deepEqual(brief(categories), [
    ["breaks", null, ["error_loop"], 1, false],
    ["misleads", null, [], 0, true],
    ["wastes", null, [], 0, true],
    ["tidies", null, [], 0, true],
  ]);
  assert.ok(categories.every((c) => c.rates.length === 0));
});

test("an early row stays in its category, counted apart, and costs no points", () => {
  const { score, categories } = read([], { tooEarly: [sig("a", "tool_switch", 3)] });
  assert.equal(score?.value, 100);
  const [, misleads] = categories;
  assert.deepEqual(
    [misleads?.lost, misleads?.issues, misleads?.early, misleads?.rows.length, misleads?.healthy],
    [0, 0, 1, 1, false],
  );
});

test("an unknown tool whose calls ran is listed and costs no points", () => {
  const { score, rows, categories } = read([sig("a", "unknown_tool", 20)], {
    metrics: { toolStanding: "succeeded" },
  });
  assert.equal(score?.value, 100);
  assert.equal(rows[0]?.points, 0);
  assert.deepEqual(brief(categories)[0], ["breaks", 0, ["unknown_tool"], 1, false]);
});
