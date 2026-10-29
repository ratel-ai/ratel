import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_TURN_CONFIG } from "@/lib/ledger/constants";
import { asStoredTurn, fixtureEvents, type TurnFixture, turn } from "@/lib/ledger/test-support";
import { buildTurns, reloadReach } from "@/lib/ledger/turns/build-turn";
import type { NormalizedEvent, TurnDraft } from "@/lib/ledger/types";

const IDLE = DEFAULT_TURN_CONFIG.idleCloseMs;

function sorted(turns: readonly TurnDraft[]): TurnDraft[] {
  return [...turns].sort((a, b) =>
    `${a.sessionId}\u0000${a.turnKey}`.localeCompare(`${b.sessionId}\u0000${b.turnKey}`),
  );
}

function full(events: readonly NormalizedEvent[], now: Date): TurnDraft[] {
  return sorted(buildTurns({ stored: [], events, now }).turns);
}

/**
 * What the job leaves in the ledger after two pages: page one built at
 * `firstNow`, then page two re-deriving the turns the loader would reload
 * (in the page's sessions: open, idle-closed, named by a declared id, or inside
 * the page's reload reach), and the idle close over the rest. Mirrors
 * `loadReloadableTurns` (including its reach predicate) + `closeIdle`.
 */
function incremental(
  events: readonly NormalizedEvent[],
  cut: number,
  firstNow: Date,
  now: Date,
): TurnDraft[] {
  const batch1 = events.filter((e) => e.receivedAt <= cut);
  const batch2 = events.filter((e) => e.receivedAt > cut);
  const first = buildTurns({ stored: [], events: batch1, now: firstNow }).turns;
  const sessions = new Set(batch2.map((e) => e.sessionId));
  const declared = new Set(
    batch2.flatMap((e) => (e.declaredTurnId ? [`declared:${e.declaredTurnId}`] : [])),
  );
  const reach = reloadReach(batch2);
  const pendingSessions = new Set(
    first
      .filter(
        (t) =>
          reach !== null &&
          sessions.has(t.sessionId) &&
          t.endedAt >= reach.pairingFloor &&
          t.steps.some(
            (s) =>
              s.eventType === "invoke_start" &&
              s.endTraceEventId === null &&
              s.occurredAt >= reach.pairingFloor,
          ),
      )
      .map((t) => t.sessionId),
  );
  const reachable = (t: TurnDraft) =>
    reach !== null &&
    (t.endedAt >= reach.gatewayFloor ||
      (t.endedAt >= reach.pairingFloor && pendingSessions.has(t.sessionId)));
  const reload = first.filter(
    (t) =>
      sessions.has(t.sessionId) &&
      (t.status === "open" || t.endedBy === "idle" || declared.has(t.turnKey) || reachable(t)),
  );
  const kept = first
    .filter((t) => !reload.includes(t))
    .map((t) =>
      t.status === "open" && t.lastReceivedAt.getTime() < now.getTime() - IDLE
        ? { ...t, status: "closed" as const, endedBy: "idle" as const }
        : t,
    );
  const second = buildTurns({ stored: reload.map((t) => asStoredTurn(t)), events: batch2, now });
  assert.deepEqual(second.orphanedTurnIds, [], "keys are stable across a rebuild");
  return sorted([...kept, ...second.turns]);
}

function scenario(): TurnFixture[] {
  const declared = turn({ session: "s-declared", turnId: "t1" }).search(["a", "b"]).invoke("b");
  const declared2 = turn({ after: declared, turnId: "t2", gapMs: 3_000 })
    .search(["c"])
    .invoke("c")
    .error("c");
  const lateT1 = turn({ after: declared2, turnId: "t1", gapMs: 1_000 }).invoke("a");
  const mixed = turn({ after: lateT1, gapMs: 20_000 })
    .gatewaySearch(3)
    .search(["d", "e"])
    .invoke("e");
  const inferred = turn({ session: "s-inferred" })
    .search(["x", "y"])
    .invoke("y")
    .search(["z"])
    .invoke("z");
  const afterGap = turn({ after: inferred, gapMs: 120_000 })
    .search(["x"])
    .invoke("x", { open: true });
  const busy = turn({ session: "s-busy" });
  for (let i = 0; i < 44; i++) busy.search([`t${i % 5}`]);
  busy.invoke("t1");
  return [declared, declared2, lateT1, mixed, inferred, afterGap, busy];
}

test("building page by page writes the ledger one full pass would, at every cut", () => {
  const events = fixtureEvents(scenario());
  const now = new Date(Math.max(...events.map((e) => e.receivedAt)) + 1);
  const expected = full(events, now);
  const cuts = [...new Set(events.map((e) => e.receivedAt))].sort((a, b) => a - b);

  assert.ok(expected.length >= 6, "the scenario exercises several turns");
  for (const cut of cuts) {
    assert.deepEqual(incremental(events, cut, new Date(cut + 1), now), expected, `cut at ${cut}`);
  }
});

/** Every distinct receipt time of `events`, each a page boundary to try. */
function everyCut(events: readonly NormalizedEvent[]): number[] {
  return [...new Set(events.map((e) => e.receivedAt))].sort((a, b) => a - b);
}

function invokeSteps(t: TurnDraft) {
  return t.steps.filter((s) => s.kind === "invoke");
}

for (const invocationId of [null, "inv-1"]) {
  test(`an end on a later page pairs into its start's closed turn (invocation id ${invocationId ?? "absent"})`, () => {
    const started = turn({ session: `s-pair-${invocationId}` })
      .search(["a", "b"])
      .invoke("a", { open: true, invocationId });
    const next = turn({ after: started, gapMs: 120_000 }).search(["x"]).end("a", { invocationId });
    const events = fixtureEvents([started, next]);
    const now = new Date(next.lastReceivedMs + 1);
    const expected = full(events, now);

    assert.equal(expected.length, 2);
    const [first, second] = expected;
    assert.equal(first.endedBy, "gap");
    assert.deepEqual(
      invokeSteps(first).map((s) => [s.targetId, s.outcome]),
      [["a", "ok"]],
    );
    assert.deepEqual(invokeSteps(second), [], "no phantom invocation in the unrelated turn");
    for (const cut of everyCut(events)) {
      assert.deepEqual(incremental(events, cut, new Date(cut + 1), now), expected, `cut at ${cut}`);
    }
  });
}

test("a gateway row on a later page dedupes against a native row of a closed turn", () => {
  const native = turn({ session: "s-gateway" }).search(["a", "b"]).invoke("a");
  const searchedAt = native.rows()[0].occurredAt!.getTime();
  const next = turn({ after: native, gapMs: 120_000 }).search(["x"]);
  const late = turn({ after: next })
    .at(searchedAt + 1_000)
    .gatewaySearch(2)
    .gatewayInvoke("a");
  const events = fixtureEvents([native, next, late]);
  const now = new Date(late.lastReceivedMs + 1);
  const expected = full(events, now);

  assert.equal(expected.length, 2);
  assert.deepEqual(
    expected.flatMap((t) => t.steps.map((s) => s.eventType)),
    ["search", "invoke_start", "search"],
    "both gateway rows restate native ones and are dropped",
  );
  for (const cut of everyCut(events)) {
    assert.deepEqual(incremental(events, cut, new Date(cut + 1), now), expected, `cut at ${cut}`);
  }
});

test("an unpaired start reloads every later turn of its session, not just its own", () => {
  // The declared middle turn closes the first one as `next_turn`; rebuilding
  // the first and last without it would relabel that close as `gap`.
  const started = turn({ session: "s-suffix" }).search(["a"]).invoke("a", { open: true });
  const middle = turn({ after: started, gapMs: 30_000, turnId: "d" }).search(["m"]).invoke("m");
  const last = turn({ after: middle, gapMs: 100_000 }).search(["x"]).end("a");
  const events = fixtureEvents([started, middle, last]);
  const now = new Date(last.lastReceivedMs + 1);
  const expected = full(events, now);

  assert.equal(expected.length, 3);
  const opener = expected.find((t) =>
    t.steps.some((s) => s.eventType === "invoke_start" && s.targetId === "a"),
  );
  assert.equal(opener?.endedBy, "next_turn");
  assert.deepEqual(
    invokeSteps(opener!).map((s) => s.outcome),
    ["ok"],
  );
  for (const cut of everyCut(events)) {
    assert.deepEqual(incremental(events, cut, new Date(cut + 1), now), expected, `cut at ${cut}`);
  }
});

test("an idle-closed turn a later page continues is reloaded and re-derived", () => {
  const first = turn({ session: "s-idle" }).search(["a"]).invoke("a");
  const resumed = turn({ after: first, gapMs: 40 * 60_000 })
    .search(["b"])
    .invoke("b");
  const events = fixtureEvents([first, resumed]);
  const cut = first.lastReceivedMs;
  const now = new Date(resumed.lastReceivedMs + 1);

  const result = incremental(events, cut, new Date(cut + 35 * 60_000), now);

  assert.deepEqual(result, full(events, now));
  assert.deepEqual(
    result.map((t) => t.endedBy),
    ["gap", null],
  );
});

test("a search and its invocation in two pages attribute as one turn", () => {
  const split = turn({ session: "s-split" }).search(["a", "b", "c"]).invoke("c");
  const events = fixtureEvents([split]);
  const cut = events[0].receivedAt;
  const now = new Date(split.lastReceivedMs + 1);

  const [built] = incremental(events, cut, new Date(cut + 1), now);

  assert.equal(built.searchCount, 1);
  assert.equal(built.steps[1].offeredRank, 3);
  assert.equal(built.firstTry, true);
});

test("rebuilding a turn from its own steps reproduces it", () => {
  const events = fixtureEvents(scenario());
  const now = new Date(Math.max(...events.map((e) => e.receivedAt)) + 1);
  const turns = buildTurns({ stored: [], events, now }).turns;

  for (const t of turns) {
    const again = buildTurns({ stored: [asStoredTurn(t)], events: [], now });
    // A lone turn rebuilt without its neighbours keeps its own content; only
    // the neighbour-derived close reason can differ, so compare the rest.
    assert.equal(again.turns.length, 1);
    const [rebuilt] = again.turns;
    assert.deepEqual({ ...rebuilt, status: t.status, endedBy: t.endedBy }, t);
  }
});

test("an imported turn reloaded from the ledger stays closed, alone or with more of its run", () => {
  const imported = turn({
    lane: "otlp",
    session: "trace-imp",
    traceId: "trace-imp",
    source: "langfuse-import",
  }).invoke("a");
  const events = fixtureEvents([imported]);
  const now = new Date(imported.lastReceivedMs + 1);
  const [built] = buildTurns({ stored: [], events, now }).turns;
  assert.deepEqual([built.status, built.endedBy], ["closed", "idle"]);

  // Rebuilt from its own steps, the import mark rides on every event again.
  const [rebuilt] = buildTurns({ stored: [asStoredTurn(built)], events: [], now }).turns;
  assert.deepEqual(rebuilt, built);

  // A later page of the same run (a second import of the window) re-derives it, still closed.
  const more = turn({ after: imported, gapMs: 1_000, traceId: "trace-imp" }).invoke("b");
  const later = fixtureEvents([more]);
  const [continued] = buildTurns({
    stored: [asStoredTurn(built)],
    events: later,
    now: new Date(more.lastReceivedMs + 1),
  }).turns;
  assert.equal(continued.invokeCount, 2);
  assert.deepEqual([continued.status, continued.endedBy], ["closed", "idle"]);
});

test("an event already stored is not counted twice", () => {
  const events = fixtureEvents([turn({ session: "s-dup" }).search(["a"]).invoke("a")]);
  const now = new Date(Math.max(...events.map((e) => e.receivedAt)) + 1);
  const [built] = buildTurns({ stored: [], events, now }).turns;

  const again = buildTurns({ stored: [asStoredTurn(built)], events, now });

  assert.deepEqual(again.turns, [built]);
});
