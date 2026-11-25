import assert from "node:assert/strict";
import { test } from "node:test";
import type { TurnFixture } from "@/lib/ledger/test-support";
import {
  type FailureStreak,
  failureStreaks,
  leadingStreak,
} from "@/lib/readings/trace-signals/outcomes/followed";
import { FAILURE_FOLLOWED } from "@/lib/readings/trace-signals/outcomes/kinds";
import {
  leftOpen,
  readSession,
  readTurnOutcome,
  type SessionTurn,
} from "@/lib/readings/trace-signals/outcomes/read";
import {
  SEARCH_RUN_MAX_SEARCHES,
  searchRuns,
} from "@/lib/readings/trace-signals/outcomes/search-runs";
import { detectAfterErrors } from "@/lib/readings/trace-signals/self-corrections/detect";
import { fresh, signalTurns, times } from "@/lib/readings/trace-signals/signals/test-fixtures";
import type { SignalTurn } from "@/lib/readings/trace-signals/signals/types";

const one = (fixture: TurnFixture): SignalTurn => signalTurns([fixture])[0]!;

/** `tool#ordinals followed`, plus recovered or stuck. */
const brief = (streaks: readonly FailureStreak[]): string[] =>
  streaks.map(
    (s) => `${s.tool}#${s.ordinals.join(",")} ${s.followed} ${s.recovered ? "recovered" : "stuck"}`,
  );

const streaksOf = (fixture: TurnFixture): string[] => brief(failureStreaks(one(fixture).steps));

// --- what followed a failure ---------------------------------------------------

test("a clean turn has no failure streak", () => {
  assert.deepEqual(streaksOf(fresh().search(["a", "b"]).invoke("a").invoke("b")), []);
});

test("fixed_next_try: the very next step is the same tool and it worked", () => {
  assert.deepEqual(streaksOf(fresh().invoke("a").error("a").invoke("a")), [
    "a#1 fixed_next_try recovered",
  ]);
});

test("consecutive errors on one tool are one streak, read at its last failed call", () => {
  assert.deepEqual(
    streaksOf(
      fresh().invoke("a").error("a").invoke("a").error("a").invoke("a").error("a").invoke("a"),
    ),
    ["a#1,2,3 fixed_next_try recovered"],
  );
  assert.deepEqual(
    streaksOf(fresh().invoke("a").error("a").invoke("a").error("a").invoke("a").error("a")),
    ["a#1,2,3 nothing_followed stuck"],
  );
});

test("a search between two failed tries does not break the streak", () => {
  assert.deepEqual(
    streaksOf(fresh().invoke("a").error("a").search(["a", "b"]).invoke("a").error("a")),
    ["a#1,3 nothing_followed stuck"],
  );
});

test("fixed_after_detour: the same tool worked later, after a search", () => {
  assert.deepEqual(streaksOf(fresh().invoke("a").error("a").search(["q", "r"]).invoke("a")), [
    "a#1 fixed_after_detour recovered",
  ]);
});

test("fixed_after_detour: the same tool worked later, after another call", () => {
  assert.deepEqual(streaksOf(fresh().invoke("a").error("a").invoke("b").invoke("a")), [
    "a#1 fixed_after_detour recovered",
  ]);
});

test("switched_tool: the next call is another tool and the failed one never worked again", () => {
  assert.deepEqual(streaksOf(fresh().invoke("a").error("a").invoke("b")), [
    "a#1 switched_tool recovered",
  ]);
  assert.deepEqual(streaksOf(fresh().invoke("a").error("a").invoke("b").error("b")), [
    "a#1 switched_tool stuck",
    "b#2 nothing_followed stuck",
  ]);
});

test("nothing_followed: no call after the failure; a search after it is not a run", () => {
  assert.deepEqual(streaksOf(fresh().invoke("b").invoke("a").error("a")), [
    "a#2 nothing_followed stuck",
  ]);
  assert.deepEqual(streaksOf(fresh().invoke("a").error("a").search(["q", "r", "s"])), [
    "a#1 nothing_followed stuck",
  ]);
});

test("a call of another tool, or one that did not fail, ends a streak", () => {
  // a fails, b works, a fails again and is fixed: two streaks of a.
  assert.deepEqual(
    streaksOf(fresh().invoke("a").error("a").invoke("b").invoke("a").error("a").invoke("a")),
    ["a#1 fixed_after_detour recovered", "a#3 fixed_next_try recovered"],
  );
  // a fails, a different tool fails: one streak each.
  assert.deepEqual(streaksOf(fresh().invoke("a").error("a").invoke("b").error("b").invoke("b")), [
    "a#1 switched_tool recovered",
    "b#2 fixed_next_try recovered",
  ]);
});

test("a retry whose end was never seen is neither a fix nor a failure", () => {
  assert.deepEqual(streaksOf(fresh().invoke("a").error("a").invoke("a", { open: true })), [
    "a#1 nothing_followed stuck",
  ]);
  const seenLater = fresh()
    .invoke("a")
    .error("a")
    .invoke("a", { open: true, invocationId: "never-ends" })
    .invoke("a", { invocationId: "ends" });
  assert.deepEqual(streaksOf(seenLater), ["a#1 fixed_after_detour recovered"]);
});

test("a skill is a tool of its own", () => {
  assert.deepEqual(streaksOf(fresh().invoke("deploy").error("deploy").skill("deploy")), [
    "deploy#1 switched_tool recovered",
  ]);
});

test("every failed call is in exactly one streak, and every streak has one of the four outcomes", () => {
  const fixtures = [
    fresh().invoke("a").error("a").invoke("a").error("a").invoke("b").invoke("a"),
    fresh()
      .search(["a"])
      .invoke("a")
      .error("a")
      .search(["a", "b"])
      .invoke("c")
      .error("c")
      .invoke("c")
      .error("c"),
    fresh().invoke("a").error("a").invoke("b").error("b").invoke("a").error("a").invoke("b"),
  ];
  for (const turn of signalTurns(fixtures)) {
    const streaks = failureStreaks(turn.steps);
    const failed = turn.steps
      .filter((step) => step.outcome === "error")
      .map((step) => step.ordinal);
    assert.deepEqual(
      streaks.flatMap((streak) => streak.ordinals),
      failed,
    );
    for (const streak of streaks) assert.ok(FAILURE_FOLLOWED.includes(streak.followed));
  }
});

test("a streak nothing followed is the turn's give-up, as the self-corrections read it", () => {
  const turn = one(
    fresh().invoke("a").error("a").invoke("b").invoke("c").error("c").invoke("c").error("c"),
  );
  const gaveUp = detectAfterErrors(turn.steps).filter(
    (event) => event.kind === "gave_up_after_error",
  );
  const stuck = failureStreaks(turn.steps).filter(
    (streak) => streak.followed === "nothing_followed",
  );
  assert.deepEqual(
    stuck.map((streak) => streak.ordinals.at(-1)),
    gaveUp.map((event) => event.toolOrdinal),
  );
});

test("the leading streak is the one that ended worst, the earliest on a tie", () => {
  const streak = (tool: string, followed: FailureStreak["followed"]): FailureStreak => ({
    tool,
    ordinals: [1],
    followed,
    recovered: false,
  });
  assert.equal(leadingStreak([]), null);
  assert.equal(
    leadingStreak([
      streak("a", "fixed_next_try"),
      streak("b", "switched_tool"),
      streak("c", "fixed_after_detour"),
    ])?.tool,
    "b",
  );
  assert.equal(
    leadingStreak([streak("a", "switched_tool"), streak("b", "nothing_followed")])?.tool,
    "b",
  );
  assert.equal(
    leadingStreak([streak("a", "fixed_next_try"), streak("b", "fixed_next_try")])?.tool,
    "a",
  );
});

// --- search runs -----------------------------------------------------------------

const runsOf = (fixture: TurnFixture, max?: number): string[] =>
  searchRuns(one(fixture).steps, max).map((run) => `${run.kind}@${run.ordinal}x${run.searches}`);

/** `n` searches in a row, each for something else. */
function searches(fixture: TurnFixture, n: number): TurnFixture {
  times(n, (i) => fixture.search([`t${i}`, `u${i}`], { query: `query ${i}` }));
  return fixture;
}

test("a search run with a call after it is answered", () => {
  assert.deepEqual(runsOf(fresh().search(["a"]).search(["a", "b"]).invoke("a")), ["answered@1x2"]);
});

test("a search run with no call after it is unmet", () => {
  assert.deepEqual(runsOf(fresh().search(["a"])), ["unmet@1x1"]);
  assert.deepEqual(runsOf(fresh().search(["a"]).invoke("a").search(["q"]).search(["r"])), [
    "answered@1x1",
    "unmet@3x2",
  ]);
});

test("a failed call after a search run still answers it: the run found something to try", () => {
  assert.deepEqual(runsOf(fresh().search(["a"]).invoke("a").error("a")), ["answered@1x1"]);
});

test("a run longer than the cap is a catalog listing, with or without a call after it", () => {
  assert.equal(SEARCH_RUN_MAX_SEARCHES, 5);
  assert.deepEqual(runsOf(searches(fresh(), 5)), ["unmet@1x5"]);
  assert.deepEqual(runsOf(searches(fresh(), 6)), ["catalog_listing@1x6"]);
  assert.deepEqual(runsOf(searches(fresh(), 6).invoke("t0")), ["catalog_listing@1x6"]);
  assert.deepEqual(runsOf(searches(fresh(), 3), 2), ["catalog_listing@1x3"]);
});

// --- one turn, one session ---------------------------------------------------------

test("a turn's reading counts its calls, streaks and search runs", () => {
  const turn = one(
    fresh().search(["a"]).invoke("a").error("a").invoke("a").error("a").invoke("b").search(["q"]),
  );
  const reading = readTurnOutcome(turn.steps);
  assert.deepEqual(
    { ...reading, streaks: brief(reading.streaks) },
    {
      okCalls: 1,
      failedCalls: 2,
      streaks: ["a#2,3 switched_tool recovered"],
      unmetSearches: 1,
      catalogListings: 0,
    },
  );
  assert.deepEqual(readTurnOutcome(one(searches(fresh(), 7)).steps), {
    okCalls: 0,
    failedCalls: 0,
    streaks: [],
    unmetSearches: 0,
    catalogListings: 1,
  });
});

const BASE = Date.parse("2026-03-01T10:00:00Z");

function sessionTurn(
  minute: number,
  facts: Partial<Omit<SessionTurn, "turnId" | "startedAt" | "endedAt">> = {},
): SessionTurn {
  return {
    turnId: `turn-${minute.toString().padStart(3, "0")}`,
    startedAt: new Date(BASE + minute * 60_000),
    endedAt: new Date(BASE + minute * 60_000 + 30_000),
    okCalls: 1,
    failedCalls: 0,
    streaks: 0,
    unmetSearches: 0,
    catalogListings: 0,
    ...facts,
  };
}

test("a session folds its turns in start order, whatever order they come in", () => {
  const turns = [
    sessionTurn(20, { failedCalls: 2, streaks: 1 }),
    sessionTurn(0),
    sessionTurn(10, { okCalls: 0, unmetSearches: 1 }),
    sessionTurn(30, { catalogListings: 1, okCalls: 0 }),
  ];
  assert.deepEqual(readSession(turns), {
    turnCount: 4,
    frictionCount: 2,
    firstTurnId: "turn-000",
    lastTurnId: "turn-030",
    startedAt: new Date(BASE),
    endedAt: new Date(BASE + 30 * 60_000 + 30_000),
    openRequest: false,
    unmetSearches: 1,
    catalogListings: 1,
  });
  assert.equal(readSession([]), null);
});

test("open request: the last turn asked for something and no call in it worked", () => {
  // The last turn's only call failed.
  assert.equal(
    readSession([sessionTurn(0), sessionTurn(10, { okCalls: 0, failedCalls: 1, streaks: 1 })])
      ?.openRequest,
    true,
  );
  // The last turn searched and ran nothing.
  assert.equal(
    readSession([sessionTurn(0), sessionTurn(10, { okCalls: 0, unmetSearches: 1 })])?.openRequest,
    true,
  );
  // A call failed but another worked in the same turn.
  assert.equal(
    readSession([sessionTurn(0, { okCalls: 1, failedCalls: 1, streaks: 1 })])?.openRequest,
    false,
  );
  // An earlier turn was left open, the last one worked.
  assert.equal(
    readSession([sessionTurn(0, { okCalls: 0, failedCalls: 1, streaks: 1 }), sessionTurn(10)])
      ?.openRequest,
    false,
  );
});

test("a last turn that only listed the catalog, or whose calls never ended, is not an open request", () => {
  assert.equal(leftOpen({ okCalls: 0, failedCalls: 0, unmetSearches: 0 }), false);
  assert.equal(
    readSession([sessionTurn(0), sessionTurn(10, { okCalls: 0, catalogListings: 1 })])?.openRequest,
    false,
  );
});
