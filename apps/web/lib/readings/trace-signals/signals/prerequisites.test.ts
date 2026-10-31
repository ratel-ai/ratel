import assert from "node:assert/strict";
import { test } from "node:test";
import type { StepDraft } from "@/lib/ledger/types";
import { analyzeTurns } from "@/lib/readings/trace-signals/signals/analyze";
import { flowView } from "@/lib/readings/trace-signals/signals/flow-model";
import {
  countPrerequisites,
  createPrerequisiteStats,
  finishPrerequisites,
  PREREQ_WINDOW_MS,
  type StoredPrerequisites,
} from "@/lib/readings/trace-signals/signals/prerequisites";
import { contextFor } from "@/lib/readings/trace-signals/signals/test-fixtures";
import type { SignalTurn } from "@/lib/readings/trace-signals/signals/types";

const T0 = Date.parse("2026-09-01T09:00:00Z");
const MIN = 60_000;
let serial = 0;

/** A closed turn of a session: calls at minutes after T0. */
function turn(session: string, calls: [string, number][], user: string | null = null): SignalTurn {
  serial += 1;
  const steps = calls.map(
    ([id, minute], ordinal) =>
      ({
        ordinal,
        kind: "invoke",
        targetType: "tool",
        targetId: id,
        occurredAt: new Date(T0 + minute * MIN),
      }) as StepDraft,
  );
  const last = Math.max(...calls.map(([, minute]) => minute));
  return {
    id: `turn-${serial}`,
    sessionId: session,
    endUserKey: user,
    turnSource: "inferred",
    lane: "runtime",
    startedAt: new Date(T0 + Math.min(...calls.map(([, m]) => m)) * MIN),
    endedAt: new Date(T0 + last * MIN + 1),
    searchCount: 0,
    invokeCount: calls.length,
    errorCount: 0,
    reSearchCount: 0,
    abandoned: null,
    detour: false,
    firstTry: null,
    steps,
  };
}

function stored(
  turns: readonly SignalTurn[],
  windowMs = 10 * MIN,
): StoredPrerequisites | undefined {
  const stats = createPrerequisiteStats(windowMs);
  for (const t of [...turns].sort((a, b) => a.endedAt.getTime() - b.endedAt.getTime()))
    countPrerequisites(stats, t);
  return finishPrerequisites(stats);
}

const pair = (s: StoredPrerequisites | undefined, a: string, b: string) =>
  s?.pairs.find((p) => p.a === a && p.b === b);

/** Twenty sessions of `lookup`, a pause, then `use` in a later turn, plus unrelated traffic so lift has a baseline. */
function crossTurnSessions(gapMinutes: number): SignalTurn[] {
  return Array.from({ length: 20 }, (_, i) => [
    turn(`s${i}`, [["lookup", i * 100]]),
    turn(`s${i}`, [["use", i * 100 + gapMinutes]]),
    turn(`n${i}`, [
      ["noise", i * 100 + 50],
      ["other", i * 100 + 51],
    ]),
  ]).flat();
}

test("the window is 10 minutes by default, tunable by env", () => {
  assert.equal(PREREQ_WINDOW_MS, 10 * MIN);
});

test("a call counts as preceded when the other tool ran earlier in the session within the window, across turns", () => {
  const inside = stored(crossTurnSessions(9));
  const row = pair(inside, "lookup", "use");
  assert.ok(row, "stored");
  assert.equal(row.n, 20);
  assert.equal(row.w, 20, "every use had lookup in the 10 minutes before it");
  assert.equal(row.t, 0, "never in the same turn");
  assert.ok(row.lw >= 2);
});

test("window boundaries: exactly the window still counts, a moment past it does not", () => {
  const atEdge = stored(crossTurnSessions(10));
  assert.equal(pair(atEdge, "lookup", "use")?.w, 20, "10 minutes on the dot is inside");
  const past = stored(crossTurnSessions(10.01));
  assert.equal(pair(past, "lookup", "use"), undefined, "a moment later it no longer precedes");
  const wider = stored(crossTurnSessions(25), 30 * MIN);
  assert.equal(pair(wider, "lookup", "use")?.w, 20, "a wider window reaches further back");
});

test("sessions and end users are kept apart", () => {
  const otherSession = Array.from({ length: 20 }, (_, i) => [
    turn(`a${i}`, [["lookup", i * 100]]),
    turn(`b${i}`, [["use", i * 100 + 1]]),
    turn(`n${i}`, [
      ["noise", i * 100 + 50],
      ["other", i * 100 + 51],
    ]),
  ]).flat();
  assert.equal(
    pair(stored(otherSession), "lookup", "use"),
    undefined,
    "another session never counts",
  );
  const otherUser = Array.from({ length: 20 }, (_, i) => [
    turn(`s${i}`, [["lookup", i * 100]], "user-1"),
    turn(`s${i}`, [["use", i * 100 + 1]], "user-2"),
    turn(`n${i}`, [
      ["noise", i * 100 + 50],
      ["other", i * 100 + 51],
    ]),
  ]).flat();
  assert.equal(
    pair(stored(otherUser), "lookup", "use"),
    undefined,
    "the same session id from another end user does not count",
  );
  const sameUser = Array.from({ length: 20 }, (_, i) => [
    turn(`s${i}`, [["lookup", i * 100]], "user-1"),
    turn(`s${i}`, [["use", i * 100 + 1]], "user-1"),
    turn(`n${i}`, [
      ["noise", i * 100 + 50],
      ["other", i * 100 + 51],
    ]),
  ]).flat();
  assert.equal(pair(stored(sameUser), "lookup", "use")?.w, 20);
});

test("lift drops a tool that precedes everything: a session sync before every call", () => {
  const turns = Array.from({ length: 30 }, (_, i) => [
    turn(`s${i}`, [
      ["sync", i * 100],
      ["find", i * 100 + 1],
      ["assign", i * 100 + 2],
    ]),
    turn(`t${i}`, [
      ["sync", i * 100 + 40],
      ["search", i * 100 + 41],
      ["details", i * 100 + 42],
    ]),
  ]).flat();
  const s = stored(turns);
  const sync = pair(s, "sync", "assign");
  assert.equal(
    sync,
    undefined,
    "sync ran before every assign, but before every other call too: lift near 1",
  );
  const find = pair(s, "find", "assign");
  assert.ok(find, "find before assign is kept");
  assert.equal(find.w, 30);
  assert.equal(find.t, 30, "and it happened inside the turn");
  assert.ok(find.lt >= 2 && find.lw >= 2);
});

test("a tool needs at least 20 uses, and nothing called stores nothing", () => {
  const few = Array.from({ length: 19 }, (_, i) => [
    turn(`s${i}`, [
      ["lookup", i * 100],
      ["use", i * 100 + 1],
    ]),
    turn(`n${i}`, [["noise", i * 100 + 50]]),
  ]).flat();
  assert.equal(pair(stored(few), "lookup", "use"), undefined);
  assert.equal(stored([]), undefined);
});

test("quiet sessions are swept as turns go by, and busy ones are not", () => {
  const stats = createPrerequisiteStats(10 * MIN);
  for (let i = 0; i < 600; i += 1) countPrerequisites(stats, turn(`s${i}`, [["a", i * 20]]));
  assert.ok(stats.sessions.size < 600, `${stats.sessions.size} sessions kept`);
  assert.ok(stats.sessions.has(`s599\u0001`), "the latest session stays");
});

test("the run stores the pairs in its summary, and the page reads them; an older summary has none", () => {
  const turns = crossTurnSessions(5);
  const result = analyzeTurns(turns, contextFor(turns), { prereqWindowMs: 10 * MIN });
  const flow = result.summary.flow;
  assert.equal(pair(flow.prerequisites, "lookup", "use")?.w, 20);
  const view = flowView(flow, [], new Map([["lookup", "Look up"]]));
  assert.equal(view.journey?.prerequisites?.windowMs, 10 * MIN);
  assert.deepEqual(
    view.journey?.prerequisites?.pairs.find((p) => p.first === "lookup"),
    {
      first: "lookup",
      tool: "use",
      uses: 20,
      window: 20,
      turn: 0,
      windowLift: pair(flow.prerequisites, "lookup", "use")!.lw,
      turnLift: 0,
    },
  );
  assert.equal(view.journey?.tools.find((t) => t.id === "lookup")?.label, "Look up");
  const { prerequisites: _gone, ...older } = flow;
  assert.equal(
    flowView(older, [], new Map()).journey?.prerequisites,
    undefined,
    "a summary from before it falls back to the paths",
  );
});
