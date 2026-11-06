import assert from "node:assert/strict";
import { test } from "node:test";
import { turn } from "@/lib/ledger/test-support";
import {
  ASKED_AGAIN_MAX_GAP_MS,
  askedAgain,
  askedAgainSteps,
  detectInTurn,
  detectSelfCorrections,
  nextInSession,
  readAskedAgain,
  readsTurn,
  readTurns,
  type SelfCorrection,
  sameAskText,
  trustOf,
} from "@/lib/readings/trace-signals/self-corrections/detect";
import { fresh, signalTurns } from "@/lib/readings/trace-signals/signals/test-fixtures";
import type { SignalTurn } from "@/lib/readings/trace-signals/signals/types";
import type { RunBasis } from "@/lib/readings/trace-signals/workflows/run-basis";

/** One closed turn from one fixture. */
const one = (fixture: ReturnType<typeof fresh>): SignalTurn => signalTurns([fixture])[0]!;

/** `kind@ordinal tool#toolOrdinal:outcome`, plus recovered or stuck for the error kinds. */
const brief = (events: readonly SelfCorrection[]): string[] =>
  events.map((e) => {
    const after = e.recovered === null ? "" : e.recovered ? " recovered" : " stuck";
    return `${e.kind}@${e.ordinal} ${e.tool ?? "-"}#${e.toolOrdinal ?? "-"}:${e.toolOutcome ?? "-"}${after}`;
  });

const trusted = { sessionsTrusted: true } as const;

// --- in-turn kinds ------------------------------------------------------------

test("a clean turn corrects nothing", () => {
  const t = one(fresh().search(["a", "b"]).invoke("a").invoke("b"));
  assert.deepEqual(detectInTurn(t.steps), []);
});

test("retry_after_error: the failed tool runs again, attributed to the failed call", () => {
  const t = one(fresh().invoke("a").error("a").invoke("a"));
  assert.deepEqual(detectInTurn(t.steps), [
    {
      kind: "retry_after_error",
      ordinal: 2,
      tool: "a",
      toolOrdinal: 1,
      toolOutcome: "error",
      recovered: true,
    },
  ]);
});

test("a search between the failure and the retry does not break it", () => {
  const t = one(fresh().search(["a"]).invoke("a").error("a").search(["q", "r"]).invoke("a"));
  assert.deepEqual(brief(detectInTurn(t.steps)), ["retry_after_error@4 a#2:error recovered"]);
  // {a} vs {a,b}: Jaccard 0.5, the same ask, so that search is a correction of its own.
  const same = one(fresh().search(["a"]).invoke("a").error("a").search(["a", "b"]).invoke("a"));
  assert.deepEqual(brief(detectInTurn(same.steps)), [
    "searched_again@3 a#2:error",
    "retry_after_error@4 a#2:error recovered",
  ]);
});

test("switch_after_error: the next call is a different tool", () => {
  const t = one(fresh().invoke("a").error("a").invoke("b"));
  assert.deepEqual(brief(detectInTurn(t.steps)), ["switch_after_error@2 a#1:error recovered"]);
});

test("gave_up_after_error: the last call failed and nothing ran after it", () => {
  const t = one(fresh().invoke("a").invoke("b").error("b"));
  assert.deepEqual(brief(detectInTurn(t.steps)), ["gave_up_after_error@2 b#2:error stuck"]);
});

test("a search after the last failed call is not a run: the turn still gave up", () => {
  const t = one(fresh().search(["a"]).invoke("a").error("a").search(["q", "r", "s"]));
  assert.deepEqual(brief(detectInTurn(t.steps)), ["gave_up_after_error@2 a#2:error stuck"]);
});

test("switching away and coming back is both a switch and a retry of the one failure", () => {
  const t = one(fresh().invoke("a").error("a").invoke("b").invoke("a"));
  assert.deepEqual(brief(detectInTurn(t.steps)), [
    "switch_after_error@2 a#1:error recovered",
    "retry_after_error@3 a#1:error recovered",
  ]);
});

test("every failure in a loop is its own event; recovery is any later ok call", () => {
  const t = one(fresh().invoke("a").error("a").invoke("a").error("a").invoke("a"));
  assert.deepEqual(brief(detectInTurn(t.steps)), [
    "retry_after_error@2 a#1:error recovered",
    "retry_after_error@3 a#2:error recovered",
  ]);
});

test("a loop that never works retries, then gives up, all stuck", () => {
  const t = one(fresh().invoke("a").error("a").invoke("a").error("a"));
  assert.deepEqual(brief(detectInTurn(t.steps)), [
    "retry_after_error@2 a#1:error stuck",
    "gave_up_after_error@2 a#2:error stuck",
  ]);
});

test("a switch that fails too is not a recovery", () => {
  const t = one(fresh().invoke("a").error("a").invoke("b").error("b"));
  assert.deepEqual(brief(detectInTurn(t.steps)), [
    "switch_after_error@2 a#1:error stuck",
    "gave_up_after_error@2 b#2:error stuck",
  ]);
});

test("an unknown outcome is neither a failure nor a recovery", () => {
  const retried = one(fresh().invoke("a").error("a").invoke("a", { open: true }));
  assert.deepEqual(brief(detectInTurn(retried.steps)), ["retry_after_error@2 a#1:error stuck"]);
  const unknownFirst = one(fresh().invoke("a", { open: true }).invoke("b"));
  assert.deepEqual(detectInTurn(unknownFirst.steps), []);
});

test("single-event calls count: a gateway error retried, a switch to a skill", () => {
  const gateway = one(fresh().gatewayError("a").gatewayInvoke("a"));
  assert.deepEqual(brief(detectInTurn(gateway.steps)), ["retry_after_error@2 a#1:error recovered"]);
  const skill = one(fresh().invoke("a").error("a").skill("s"));
  assert.deepEqual(brief(detectInTurn(skill.steps)), ["switch_after_error@2 a#1:error recovered"]);
});

test("a skill is its own node: a tool and a skill of one id are different calls", () => {
  const t = one(fresh().invoke("a").error("a").skill("a"));
  assert.deepEqual(brief(detectInTurn(t.steps)), ["switch_after_error@2 a#1:error recovered"]);
  const after = one(fresh().search(["a", "b"]).skill("s").search(["a", "b"]));
  assert.deepEqual(brief(detectInTurn(after.steps)), ["searched_again@3 skill:s#2:ok"]);
});

test("searched_again: the same ask with no call between is attributed to no tool", () => {
  // {a,b,c} vs {a,b,d}: Jaccard 0.5, the same-ask bar.
  const t = one(fresh().search(["a", "b", "c"]).search(["a", "b", "d"]).invoke("a"));
  assert.deepEqual(brief(detectInTurn(t.steps)), ["searched_again@2 -#-:-"]);
});

test("searched_again after a call is attributed to that call", () => {
  const t = one(
    fresh().search(["a", "b", "c"]).invoke("a").search(["a", "b", "c"], { query: "other words" }),
  );
  assert.deepEqual(brief(detectInTurn(t.steps)), ["searched_again@3 a#2:ok"]);
});

test("a call before the earlier search is not what the repeated search corrects", () => {
  const t = one(fresh().invoke("z").search(["a", "b", "c"]).search(["a", "b", "c"]));
  assert.deepEqual(brief(detectInTurn(t.steps)), ["searched_again@3 -#-:-"]);
});

test("a search for a new need is a next step, not a correction", () => {
  const t = one(
    fresh()
      .search(["find_task", "search_tasks", "list_projects"], {
        query: "find the Q3 roadmap review",
      })
      .invoke("find_task")
      .search(["search_tasks", "list_task_comments", "create_task", "update_task"], {
        query: "change its priority",
      })
      .invoke("update_task"),
  );
  assert.deepEqual(detectInTurn(t.steps), []);
});

test("the same-ask bar is tunable", () => {
  const t = one(fresh().search(["a", "b", "c"]).search(["a", "b", "d"]));
  assert.deepEqual(detectInTurn(t.steps, 0.51), []);
});

// --- asked_again --------------------------------------------------------------

/** Two turns of one user in one session, `gapMs` apart, with these first searches. */
function pair(
  gapMs: number,
  first: { hits: string[]; query: string },
  second: { hits: string[]; query: string },
) {
  const a = fresh({ endUser: "u1" })
    .search(first.hits, { query: first.query })
    .invoke(first.hits[0]!);
  const b = turn({ after: a, gapMs })
    .search(second.hits, { query: second.query })
    .invoke(second.hits[0]!);
  const [ta, tb] = signalTurns([a, b]);
  return { ta: ta!, tb: tb! };
}

const roadmap = { hits: ["find_task", "search_tasks"], query: "find the Q3 roadmap review" };

test("asked_again: the next turn's first search asks the same thing within the gap", () => {
  const { ta, tb } = pair(2 * 60_000, roadmap, roadmap);
  assert.equal(askedAgain(ta, tb, trusted), true);
  const reading = detectSelfCorrections(ta, tb, trusted);
  assert.equal(reading.askedAgain, true);
  assert.deepEqual(brief(reading.events), ["asked_again@2 find_task#2:ok"]);
});

test("asked_again is pinned to the earlier turn's last step and its last call", () => {
  const a = fresh({ endUser: "u1" })
    .search(["a", "b"], { query: "q" })
    .invoke("a")
    .error("a")
    .search(["c"]);
  const b = turn({ after: a, gapMs: 120_000 }).search(["a", "b"], { query: "q" });
  const [ta, tb] = signalTurns([a, b]);
  assert.deepEqual(brief(detectSelfCorrections(ta!, tb!, trusted).events), [
    "gave_up_after_error@2 a#2:error stuck",
    "asked_again@3 a#2:error",
  ]);
});

test("a next turn past the gap limit, or none at all, did not ask again", () => {
  const { ta, tb } = pair(ASKED_AGAIN_MAX_GAP_MS + 60_000, roadmap, roadmap);
  assert.equal(askedAgain(ta, tb, trusted), false);
  assert.equal(askedAgain(ta, null, trusted), false);
  assert.deepEqual(detectSelfCorrections(ta, null, trusted), { events: [], askedAgain: false });
  assert.equal(
    askedAgain(ta, tb, { ...trusted, maxGapMs: ASKED_AGAIN_MAX_GAP_MS + 120_000 }),
    true,
    "the gap is tunable",
  );
});

test("a different ask in the next turn is not asking again", () => {
  const other = { hits: ["create_task", "update_task"], query: "create a launch checklist" };
  const { ta, tb } = pair(60_000 * 2, roadmap, other);
  assert.equal(askedAgain(ta, tb, trusted), false);
});

test("sessions the run-boundary rules do not trust cannot tell", () => {
  const { ta, tb } = pair(2 * 60_000, roadmap, roadmap);
  assert.equal(askedAgain(ta, tb, { sessionsTrusted: false }), null);
  assert.deepEqual(detectSelfCorrections(ta, tb, { sessionsTrusted: false }), {
    events: [],
    askedAgain: null,
  });
});

test("another session or another end user is not this user's next turn", () => {
  const { ta, tb } = pair(2 * 60_000, roadmap, roadmap);
  assert.equal(askedAgain(ta, { ...tb, sessionId: "elsewhere" }, trusted), false);
  assert.equal(askedAgain(ta, { ...tb, endUserKey: "someone-else" }, trusted), false);
});

test("a quick next turn without a comparable ask cannot tell", () => {
  const a = fresh({ endUser: "u1" }).search(["a"], { query: "q" }).invoke("a");
  const b = turn({ after: a, gapMs: 120_000 }).invoke("a");
  const [ta, tb] = signalTurns([a, b]);
  assert.equal(askedAgain(ta!, tb!, trusted), null, "the next turn never searched");
  const c = fresh({ endUser: "u1" }).invoke("a");
  const d = turn({ after: c, gapMs: 120_000 }).search(["a"], { query: "q" });
  const [tc, td] = signalTurns([c, d]);
  assert.equal(askedAgain(tc!, td!, trusted), null, "the earlier turn never searched");
  const gateway = fresh({ endUser: "u1" }).gatewaySearch(3, { query: "q" });
  const listing = turn({ after: gateway, gapMs: 120_000 }).search(["a"], { query: "other" });
  const [tg, tl] = signalTurns([gateway, listing]);
  assert.equal(
    askedAgain(tg!, tl!, trusted),
    false,
    "query hashes compare even when one side lists no hits",
  );
});

test("a run cut at a cap continues in the next turn, which is not the user asking", () => {
  const { ta, tb } = pair(2 * 60_000, roadmap, roadmap);
  assert.equal(askedAgain({ ...ta, endedBy: "cap" }, tb, trusted), null);
});

test("a next turn that starts before this one ended is concurrent: cannot tell", () => {
  const { ta, tb } = pair(2 * 60_000, roadmap, roadmap);
  assert.equal(
    askedAgain(ta, { ...tb, startedAt: new Date(ta.endedAt.getTime() - 1_000) }, trusted),
    null,
  );
});

test("the user's own words decide when both turns carry them", () => {
  const { ta, tb } = pair(2 * 60_000, roadmap, { hits: ["create_task"], query: "something else" });
  assert.equal(
    askedAgain(
      { ...ta, askText: "Find the Q3 roadmap review" },
      { ...tb, askText: "  find the q3   ROADMAP review " },
      trusted,
    ),
    true,
  );
  const same = pair(2 * 60_000, roadmap, roadmap);
  assert.equal(
    askedAgain(
      { ...same.ta, askText: "find the Q3 roadmap review" },
      { ...same.tb, askText: "change the priority of the Q3 roadmap review" },
      trusted,
    ),
    false,
    "a follow-up on the same object is a new need, whatever the searches say",
  );
  assert.equal(
    askedAgain({ ...same.ta, askText: "find the Q3 roadmap review" }, same.tb, trusted),
    true,
    "text on one side only: the searches decide",
  );
});

test("sameAskText: normalized equality, or most content words shared", () => {
  assert.equal(sameAskText("Export the board as PDF", "export the board as pdf"), true);
  assert.equal(
    sameAskText(
      "find the quarterly roadmap review doc",
      "find the quarterly roadmap review doc please",
    ),
    true,
  );
  assert.equal(
    sameAskText("find the Q3 roadmap review", "change the priority of the Q3 roadmap review"),
    false,
  );
  assert.equal(sameAskText("", "anything"), null, "an empty ask cannot be compared");
  assert.equal(sameAskText("   ", "   "), null);
});

// --- sessions and trust -------------------------------------------------------

test("nextInSession pairs each turn with the same user's next turn in its session", () => {
  const a = fresh({ endUser: "u1" }).search(["x"]).invoke("x");
  const b = turn({ after: a, endUser: "u2", gapMs: 120_000 }).search(["y"]).invoke("y");
  const c = turn({ after: b, endUser: "u1", gapMs: 120_000 }).search(["x"]).invoke("x");
  const d = fresh({ endUser: "u1" }).search(["x"]).invoke("x");
  const turns = signalTurns([a, b, c, d]);
  const [ta, tb, tc] = turns
    .filter((t) => t.sessionId === a.session)
    .sort((x, y) => x.startedAt.getTime() - y.startedAt.getTime());
  const td = turns.find((t) => t.sessionId === d.session);
  // Shuffled input: pairing goes by start time, not input order.
  const input = [tc!, td!, ta!, tb!];
  const next = nextInSession(input);
  assert.equal(next[2], tc, "u1's next turn skips u2's turn between");
  assert.equal(next[3], null, "u2 never came back");
  assert.equal(next[0], null, "u1's last turn in the session");
  assert.equal(next[1], null, "another session is never paired");
});

const basis = (over: Partial<RunBasis>): RunBasis => ({
  basis: "all",
  blocked: null,
  excludedRuns: 0,
  since: null,
  mixed: false,
  ...over,
});

test("trustOf: the run-boundary rules decide which runs and sessions are read", () => {
  assert.deepEqual(trustOf(basis({})), { runs: "all", sessions: true });
  assert.deepEqual(trustOf(basis({ basis: "exact", mixed: true })), {
    runs: "exact",
    sessions: false,
  });
  assert.deepEqual(trustOf(basis({ basis: "exact", mixed: false })), {
    runs: "exact",
    sessions: true,
  });
  assert.deepEqual(trustOf(basis({ basis: "none", blocked: "mixed_runs", mixed: true })), {
    runs: "none",
    sessions: false,
  });
  assert.deepEqual(
    trustOf(basis({ basis: "none", blocked: "no_tool_calls" })),
    { runs: "all", sessions: true },
    "searches alone can still be read",
  );
});

test("readTurns: pairs, gates and detects a whole list in one pass", () => {
  const { ta, tb } = pair(2 * 60_000, roadmap, roadmap);
  const declared = { ...ta, turnSource: "declared" as const };
  const all = readTurns([tb, declared], { runs: "all", sessions: true });
  assert.equal(all[1]?.askedAgain, true, "paired by start time");
  assert.equal(all[0]?.askedAgain, false, "the last turn has no next turn");
  const exact = readTurns([declared, tb], { runs: "exact", sessions: true });
  assert.equal(exact[1], null, "a guessed run is left out once exact runs are enough");
  assert.deepEqual(
    exact[0],
    { events: [], askedAgain: null },
    "its next turn was left out, so asking again cannot be told",
  );
  const untrusted = readTurns([declared, tb], { runs: "all", sessions: false });
  assert.equal(untrusted[0]?.askedAgain, null);
  assert.deepEqual(readTurns([declared, tb], { runs: "none", sessions: false }), [null, null]);
});

test("askedAgainSteps: the first search, the last call and the last step, in step order", () => {
  const t = one(
    fresh()
      .search(["a", "b"], { query: "q" })
      .invoke("a")
      .error("a")
      .search(["b"])
      .invoke("b")
      .search(["c"]),
  );
  const kept = askedAgainSteps(t.steps);
  assert.deepEqual(
    kept.map((s) => s.ordinal),
    [1, 4, 5],
  );
  assert.deepEqual(askedAgainSteps([]), []);
  const single = one(fresh().invoke("a"));
  assert.deepEqual(
    askedAgainSteps(single.steps).map((s) => s.ordinal),
    [1],
    "one step is its own first, last and last call",
  );
});

test("readAskedAgain on compact turns answers as readTurns does on whole turns", () => {
  const a = fresh({ endUser: "u1" })
    .search(["a", "b"], { query: "q" })
    .invoke("a")
    .error("a")
    .invoke("b")
    .search(["c"]);
  const b = turn({ after: a, gapMs: 120_000 }).search(["a", "b"], { query: "q" }).invoke("a");
  const c = turn({ after: b, gapMs: 120_000 })
    .search(["x"], { query: "something else" })
    .invoke("x");
  const turns = signalTurns([a, b, c]);
  const compact = turns.map((t) => ({ ...t, steps: askedAgainSteps(t.steps) }));
  for (const trust of [
    { runs: "all", sessions: true },
    { runs: "all", sessions: false },
    { runs: "none", sessions: false },
  ] as const) {
    const whole = readTurns(turns, trust).map((r) =>
      r
        ? { askedAgain: r.askedAgain, asked: r.events.filter((e) => e.kind === "asked_again") }
        : null,
    );
    const fromCompact = readAskedAgain(compact, trust).map((r) =>
      r ? { askedAgain: r.askedAgain, asked: r.event ? [r.event] : [] } : null,
    );
    assert.deepEqual(fromCompact, whole, `trust ${trust.runs}/${trust.sessions}`);
  }
  const [first] = readAskedAgain(compact, { runs: "all", sessions: true });
  assert.equal(first?.askedAgain, true);
  assert.deepEqual(brief(first?.event ? [first.event] : []), ["asked_again@4 b#3:ok"]);
});

test("readsTurn: exact runs only once the basis is exact, nothing when runs are mixed", () => {
  assert.equal(readsTurn({ runs: "all", sessions: true }, "inferred"), true);
  assert.equal(readsTurn({ runs: "exact", sessions: true }, "inferred"), false);
  assert.equal(readsTurn({ runs: "exact", sessions: true }, "declared"), true);
  assert.equal(readsTurn({ runs: "exact", sessions: true }, "otlp"), true);
  assert.equal(readsTurn({ runs: "none", sessions: false }, "declared"), false);
});
