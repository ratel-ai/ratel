import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeExplorerTurns } from "@/lib/readings/tool-explorer/analyze";
import {
  countIntentTools,
  createIntentToolStats,
  finishIntentChains,
  finishIntentEdges,
  finishIntentTools,
  groupIntents,
  intentUnitOf,
} from "@/lib/readings/tool-explorer/intents";
import { many, wfTurn } from "@/lib/readings/trace-signals/workflows/test-fixtures";

const I = {
  create: "00000000-0000-4000-8000-000000000001",
  comment: "00000000-0000-4000-8000-000000000002",
  report: "00000000-0000-4000-8000-000000000003",
  rare: "00000000-0000-4000-8000-000000000004",
};

test("an intent unit keeps first appearance order and drops repeats", () => {
  const unit = intentUnitOf({ id: "t", sessionId: "s" }, [I.comment, I.create, I.comment]);
  assert.deepEqual(unit.calls, [I.comment, I.create]);
  assert.deepEqual(unit.items, [I.create, I.comment].sort());
});

test("intent tool shares count each intent against every tool its units called, above a floor", () => {
  const stats = createIntentToolStats("turn");
  for (let i = 0; i < 10; i++)
    countIntentTools(stats, [I.create], ["create_task", i < 8 ? "add_comment" : "search"]);
  countIntentTools(stats, [I.rare], ["search"]);
  countIntentTools(stats, [], ["search"]);
  countIntentTools(stats, [I.create], []);
  const shares = finishIntentTools(stats, 5);
  assert.deepEqual(
    shares.map((s) => [s.intentId, s.toolId, s.n, s.intentUnits]),
    [
      [I.create, "create_task", 10, 10],
      [I.create, "add_comment", 8, 10],
      [I.create, "search", 2, 10],
    ],
    "the rare intent is below the floor; a unit with no calls does not count",
  );
  assert.equal(shares[0]!.share, 1);
  assert.ok(shares[1]!.shareLow < 0.8 && shares[1]!.shareLow > 0.4);
});

test("groupIntents joins intents by the clusterer's symmetric relevance and labels each group by its common words", () => {
  const groups = groupIntents(
    [
      { id: "a", text: "create a task in the project", units: 30 },
      { id: "b", text: "create task in project with a due date", units: 20 },
      { id: "c", text: "show me the weekly report", units: 15 },
      { id: "d", text: "weekly report for the team", units: 5 },
      { id: "e", text: "", units: 100 },
      { id: "f", text: "assign the task to someone on the team", units: 4 },
    ],
    0.4,
  );
  assert.deepEqual(
    groups.map((g) => g.intentIds),
    [["a", "b"], ["c", "d"], ["f"]],
    "shared words alone do not merge: 'task' and 'team' leave f on its own",
  );
  assert.deepEqual(
    groups.map((g) => g.id),
    ["g1", "g2", "g3"],
  );
  assert.match(groups[0]!.label, /create|task|project/);
  assert.equal(
    groupIntents(
      [
        { id: "x", text: "alpha", units: 1 },
        { id: "y", text: "beta", units: 1 },
      ],
      0.4,
      1,
    ).length,
    1,
    "the cap holds",
  );
});

test("analyzeExplorerTurns joins intents: per-intent tools, intent co-usage, and session-scope intents against session tools", () => {
  const turns = [
    ...many(12, (i) => ({
      ...wfTurn(["create_task", "add_comment"]),
      sessionId: `s${i}`,
      intentIds: [I.create, I.comment],
    })),
    ...many(12, (i) => ({
      ...wfTurn(["weekly_report"]),
      sessionId: `r${i}`,
      intentIds: [I.report],
    })),
    // The ask arrives in one turn, the call in the next turn of the same session.
    ...many(8, (i) => ({
      ...wfTurn([]),
      sessionId: `x${i}`,
      intentIds: [I.report],
    })),
    ...many(8, (i) => ({ ...wfTurn(["weekly_report"]), sessionId: `x${i}` })),
    ...many(5, (i) => ({ ...wfTurn(["search"]), sessionId: `n${i}` })),
  ];
  const texts = new Map([
    [I.create, "create a task"],
    [I.comment, "create the task and comment"],
    [I.report, "weekly report"],
  ]);
  const result = analyzeExplorerTurns(
    turns,
    { cousage: { minSupport: 5, minShare: 0 }, minIntentUnits: 5 },
    texts,
  );
  assert.equal(result.turnsWithIntents, 32);
  assert.deepEqual(
    result.summary.intentUnits,
    { turn: 24, session: 32 },
    "turn scope needs a call in the same turn; session scope only needs one in the session",
  );

  const turnReport = result.intentTools.filter(
    (s) => s.scope === "turn" && s.intentId === I.report,
  );
  assert.deepEqual(
    turnReport.map((s) => [s.toolId, s.n, s.intentUnits]),
    [["weekly_report", 12, 12]],
  );
  const sessionReport = result.intentTools.filter(
    (s) => s.scope === "session" && s.intentId === I.report,
  );
  assert.deepEqual(
    sessionReport.map((s) => [s.toolId, s.n, s.intentUnits]),
    [["weekly_report", 20, 20]],
    "the split sessions join at session scope",
  );

  const createTools = result.intentTools
    .filter((s) => s.scope === "turn" && s.intentId === I.create)
    .map((s) => s.toolId)
    .sort();
  assert.deepEqual(createTools, ["add_comment", "create_task"]);

  const intentPair = result.sets.find(
    (s) => s.subject === "intent" && s.scope === "turn" && s.size === 2,
  );
  assert.deepEqual(intentPair?.items, [I.create, I.comment].sort());
  assert.equal(intentPair?.support, 12);
  const intentNext = result.edges.find(
    (e) => e.subject === "intent" && e.kind === "next" && e.scope === "turn",
  );
  assert.deepEqual([intentNext?.a, intentNext?.b, intentNext?.n], [I.create, I.comment, 12]);

  assert.ok(result.summary.intentGroups && result.summary.intentGroups.length >= 2);
  const taskGroup = result.summary.intentGroups!.find((g) => g.intentIds.includes(I.create));
  assert.ok(taskGroup?.intentIds.includes(I.comment), 'two asks sharing "create" and "task" group');
  assert.ok(!taskGroup?.intentIds.includes(I.report));
  assert.ok(
    result.sets.some((s) => s.subject === "tool"),
    "tool sets are unchanged by the join",
  );
});

test("finishIntentChains keeps the commonest ordered chains per ask, in call order, and drops one-offs", () => {
  const stats = createIntentToolStats("turn");
  for (let i = 0; i < 6; i += 1) countIntentTools(stats, ["i1"], ["a", "b"], ["a", "b"]);
  for (let i = 0; i < 3; i += 1) countIntentTools(stats, ["i1"], ["a", "b"], ["b", "a"]);
  countIntentTools(stats, ["i1"], ["a", "b", "c"], ["a", "c", "b"]);
  countIntentTools(stats, ["i2"], ["a"], ["a"]);
  const chains = finishIntentChains(stats, 5);
  assert.deepEqual(
    chains,
    {
      i1: [
        { t: ["a", "b"], n: 6 },
        { t: ["b", "a"], n: 3 },
      ],
    },
    "a>c>b was seen once and i2 has too few units",
  );
});

test("finishIntentEdges keeps a sure hop ahead of a busier loose one when the cap bites", () => {
  const stats = createIntentToolStats("turn");
  // a → b in every one of 5 units (sure); c → d in 20 of 40 units (busy, loose).
  for (let i = 0; i < 5; i += 1) countIntentTools(stats, [I.create], ["a", "b"], ["a", "b"]);
  for (let i = 0; i < 20; i += 1) countIntentTools(stats, [I.create], ["c", "d"], ["c", "d"]);
  for (let i = 0; i < 20; i += 1) countIntentTools(stats, [I.create], ["c", "e"], ["c", "e"]);
  const edges = finishIntentEdges(stats, 1)[I.create]!;
  assert.deepEqual(
    edges.map((e) => `${e.a}>${e.b}:${e.n}/${e.na}`),
    ["a>b:5/5", "c>d:20/40", "c>e:20/40"],
    "the sure hop leads although it is the least counted",
  );
});
