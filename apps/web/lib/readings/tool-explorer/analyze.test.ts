import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeExplorerTurns } from "@/lib/readings/tool-explorer/analyze";
import { mineCousage, supportFloor } from "@/lib/readings/tool-explorer/cousage";
import {
  countTransitions,
  createTransitionStats,
  finishTransitions,
  firstCallOrder,
} from "@/lib/readings/tool-explorer/transitions";
import type { ExplorerEdge, ExplorerSet } from "@/lib/readings/tool-explorer/types";
import { callsOfTurn, createSessionFold, unitOfTurn } from "@/lib/readings/tool-explorer/units";
import { accumulatePairs, createPairStats } from "@/lib/readings/trace-signals/signals/pairs";
import { many, wfTurn } from "@/lib/readings/trace-signals/workflows/test-fixtures";

const inSession = (sessionId: string, calls: readonly string[]) => ({
  ...wfTurn(calls),
  sessionId,
});

const edge = (edges: readonly ExplorerEdge[], kind: ExplorerEdge["kind"], a: string, b: string) =>
  edges.find((e) => e.kind === kind && e.a === a && e.b === b);
const setOf = (sets: readonly ExplorerSet[], ...items: string[]) =>
  sets.find((s) => s.key === [...items].sort().join("|"));

test("a turn unit collapses immediate repeats, keeps order, and names skills apart from tools", () => {
  const turn = wfTurn(["a", "a", "b", "a", { tool: "s", targetType: "skill" }]);
  assert.deepEqual(callsOfTurn(turn), ["a", "b", "a", "skill:s"]);
  const unit = unitOfTurn(turn);
  assert.deepEqual(unit.items, ["a", "b", "skill:s"]);
  assert.equal(unit.sessionId, turn.sessionId);
});

test("firstCallOrder keeps each id at its first position", () => {
  assert.deepEqual(firstCallOrder(["b", "a", "b", "c", "a"]), ["b", "a", "c"]);
});

test("next edges: p is a row of the transition matrix; before edges count once per unit", () => {
  const stats = createTransitionStats("turn", "tool");
  countTransitions(stats, unitOfTurn(wfTurn(["a", "b", "a", "c"])));
  countTransitions(stats, unitOfTurn(wfTurn(["a", "b"])));
  countTransitions(stats, unitOfTurn(wfTurn(["c"])));
  const edges = finishTransitions(stats);

  const ab = edge(edges, "next", "a", "b")!;
  assert.equal(ab.n, 2);
  assert.equal(ab.nA, 3, "three calls of a had a successor");
  assert.ok(Math.abs(ab.p - 2 / 3) < 1e-9);
  assert.ok(ab.pLow < ab.p && ab.p < ab.pHigh);
  assert.equal(edge(edges, "next", "a", "c")!.n, 1);
  assert.equal(edge(edges, "next", "b", "a")!.reverseN, 2, "b>a sees a>b's count as its reverse");

  const before = edge(edges, "before", "a", "b")!;
  assert.equal(before.n, 2, "a before b in two units, however many times a ran");
  assert.equal(before.nA, 2, "two units called a");
  assert.equal(before.p, 1);
  // b appears in 2 of 3 units, so a>b's lift is 1 / (2/3).
  assert.ok(Math.abs(before.lift - 1.5) < 1e-9);
  assert.equal(edge(edges, "before", "b", "a"), undefined, "b's first call never preceded a's");
});

test("turn-scope before edges count exactly what pairs.ts counts for ordered chains", () => {
  const turns = [
    ...many(20, () => wfTurn(["list", "backlog", "estimate"])),
    ...many(10, () => wfTurn(["estimate", "list"])),
    ...many(5, () => wfTurn(["list", "list", "assign"])),
  ];
  const pairs = createPairStats(new Set(["list", "backlog", "estimate", "assign"]));
  for (const turn of turns) accumulatePairs(pairs, turn);
  const stats = createTransitionStats("turn", "tool");
  for (const turn of turns) countTransitions(stats, unitOfTurn(turn));
  const ours = new Map(
    finishTransitions(stats)
      .filter((e) => e.kind === "before")
      .map((e) => [`${e.a}>${e.b}`, e.n]),
  );
  const theirs = new Map([...pairs.ordered].map(([key, value]) => [key, value.n]));
  assert.deepEqual(ours, theirs);
});

test("the session fold concatenates a session's turns in order and collapses across the boundary", () => {
  const fold = createSessionFold();
  fold.add(unitOfTurn(inSession("s1", ["a", "b"])));
  fold.add(unitOfTurn(inSession("s2", ["c"])));
  fold.add(unitOfTurn(inSession("s1", ["b", "c"])));
  fold.add(unitOfTurn(inSession("s1", [])));
  const { units, truncated } = fold.finish();
  assert.equal(truncated, false);
  assert.deepEqual(
    units.map((u) => [u.id, [...u.calls]]),
    [
      ["s1", ["a", "b", "c"]],
      ["s2", ["c"]],
    ],
  );
});

test("the session fold reports its caps instead of growing", () => {
  const fold = createSessionFold({ maxSessions: 1, maxCalls: 2 });
  fold.add(unitOfTurn(inSession("s1", ["a", "b", "c"])));
  fold.add(unitOfTurn(inSession("s2", ["a"])));
  const { units, truncated } = fold.finish();
  assert.equal(truncated, true);
  assert.deepEqual(
    units.map((u) => [...u.calls]),
    [["a", "b"]],
  );
});

test("supportFloor is the larger of the count and the share", () => {
  assert.equal(supportFloor(100, 5, 0.01), 5);
  assert.equal(supportFloor(10_000, 5, 0.01), 100);
});

test("co-used pairs carry jaccard and both conditional shares; a pair never apart is always together", () => {
  const units = [
    ...many(40, () => wfTurn(["a", "b"])),
    ...many(10, () => wfTurn(["a", "c"])),
    ...many(10, () => wfTurn(["c", "d"])),
    ...many(30, () => wfTurn(["e"])),
  ].map(unitOfTurn);
  const result = mineCousage("turn", "tool", units, { minSupport: 5, minShare: 0 });
  assert.equal(result.units, 90);
  assert.equal(result.multiUnits, 60);

  const ab = setOf(result.sets, "a", "b")!;
  assert.equal(ab.support, 40);
  assert.ok(Math.abs(ab.share - 40 / 90) < 1e-9);
  assert.ok(Math.abs(ab.jaccard! - 40 / 50) < 1e-9, "a in 50 units, b in 40, both in 40");
  assert.ok(Math.abs(ab.pAb! - 0.8) < 1e-9);
  assert.equal(ab.pBa, 1);
  assert.ok(
    ab.jaccardLow! < 0.9,
    "a runs without b a fifth of the time, so the pair is not always together",
  );

  const cd = setOf(result.sets, "c", "d")!;
  assert.ok(Math.abs(cd.jaccard! - 0.5) < 1e-9);
  assert.equal(setOf(result.sets, "a", "d"), undefined, "never together");
  assert.ok(
    result.sets.every((s) => s.size >= 2),
    "singletons are nodes, not sets",
  );
});

test("a co-used set that is a workflow's core is named after it", () => {
  const units = many(20, () => wfTurn(["x", "y", "z"])).map(unitOfTurn);
  const result = mineCousage("turn", "tool", units, {
    minSupport: 5,
    minShare: 0,
    workflows: [{ id: "wf-xyz", coreTools: ["z", "x", "y"] }],
  });
  assert.equal(setOf(result.sets, "x", "y", "z")!.workflowId, "wf-xyz");
  assert.equal(setOf(result.sets, "x", "y")!.workflowId, null);
});

test("analyzeExplorerTurns reads both scopes: a pair split across turns is together only in the session", () => {
  const turns = [
    ...many(40, (i) => inSession(`s${i}`, ["lookup"])),
    ...many(40, (i) => inSession(`s${i}`, ["act"])),
    ...many(12, (i) => inSession(`t${i}`, ["lookup", "act"])),
  ];
  const result = analyzeExplorerTurns(turns, { cousage: { minSupport: 5, minShare: 0 } });
  assert.equal(result.turnsScanned, 92);
  assert.equal(result.sessionsScanned, 52);
  assert.deepEqual(result.summary.units, {
    turn: { units: 92, multiUnits: 12 },
    session: { units: 52, multiUnits: 52 },
  });

  const turnPair = result.sets.find((s) => s.scope === "turn" && s.key === "act|lookup")!;
  const sessionPair = result.sets.find((s) => s.scope === "session" && s.key === "act|lookup")!;
  assert.equal(turnPair.support, 12);
  assert.equal(sessionPair.support, 52);
  assert.equal(sessionPair.jaccard, 1);
  assert.ok(sessionPair.jaccardLow! >= 0.9, "52 of 52 clears the 0.9 lower bound");
  assert.ok(
    Math.abs(turnPair.jaccard! - 12 / 92) < 1e-9,
    "inside turns the pair is rare: 80 turns call one without the other",
  );
  assert.ok(turnPair.jaccardLow! < 0.9);

  const sessionNext = result.edges.find(
    (e) => e.scope === "session" && e.kind === "next" && e.a === "lookup" && e.b === "act",
  )!;
  assert.equal(sessionNext.n, 52);
  assert.equal(sessionNext.p, 1);
  assert.deepEqual(sessionNext.exampleSessions.length, 10, "examples are a bounded sample");

  const lookup = result.summary.nodes.find((n) => n.id === "lookup")!;
  assert.deepEqual(
    {
      id: lookup.id,
      subject: lookup.subject,
      calls: lookup.calls,
      turnUnits: lookup.turnUnits,
      sessionUnits: lookup.sessionUnits,
      timedCalls: lookup.timedCalls,
    },
    { id: "lookup", subject: "tool", calls: 52, turnUnits: 52, sessionUnits: 52, timedCalls: 52 },
  );
  assert.deepEqual(result.summary.truncated, { sessions: false, edges: {}, sets: {} });
});

test("row caps cut the weakest rows and say so", () => {
  const turns = many(30, () => wfTurn(["a", "b", "c", "d"]));
  const result = analyzeExplorerTurns(turns, {
    cousage: { minSupport: 5, minShare: 0 },
    maxEdgeRows: 2,
    maxSetRows: 3,
  });
  assert.equal(result.edges.filter((e) => e.scope === "turn").length, 2);
  assert.equal(result.sets.filter((s) => s.scope === "turn").length, 3);
  assert.deepEqual(result.summary.truncated.edges, { turn: true, session: true });
  assert.deepEqual(result.summary.truncated.sets, { turn: true, session: true });
});

test("co-used sets reach as many tools as the biggest task, so a task of five is named on its set", async () => {
  const { cousageSizeFor } = await import("@/lib/readings/tool-explorer/compute");
  const five = ["a", "b", "c", "d", "e"];
  assert.equal(cousageSizeFor([]), 4, "four tools at most when no task is bigger");
  assert.equal(cousageSizeFor([{ id: "wf-5", coreTools: five }]), 5);
  assert.equal(
    cousageSizeFor([{ id: "wf-12", coreTools: Array.from({ length: 12 }, (_, i) => `t${i}`) }]),
    8,
    "never past the miner's own largest set",
  );
  const turns = many(30, () => wfTurn(five));
  const workflows = [{ id: "wf-5", coreTools: five }];
  const capped = analyzeExplorerTurns(turns, {
    workflows,
    cousage: { minSupport: 5, minShare: 0 },
  });
  assert.equal(
    capped.sets.some((s) => s.workflowId === "wf-5"),
    false,
    "four tools could never hold the task",
  );
  const sized = analyzeExplorerTurns(turns, {
    workflows,
    cousage: { minSupport: 5, minShare: 0, maxSize: cousageSizeFor(workflows) },
  });
  assert.equal(setOf(sized.sets, ...five)?.workflowId, "wf-5");
});
