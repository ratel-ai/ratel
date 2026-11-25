import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClosedTurn } from "@/lib/ledger/closed-turns";
import { TimeBudgetError } from "@/lib/ledger/turn-pages";
import { OUTCOME_RULE_VERSION } from "@/lib/readings/trace-signals/outcomes/kinds";
import type { SessionTurn } from "@/lib/readings/trace-signals/outcomes/read";
import type {
  SessionOutcomeRowDraft,
  TurnOutcomeRowDraft,
} from "@/lib/readings/trace-signals/outcomes/rows";
import {
  type OutcomeRunDeps,
  recordOutcomes,
  type StoredOutcomes,
} from "@/lib/readings/trace-signals/outcomes/run";
import { outcomeLines, storedOutcomesOf } from "@/lib/readings/trace-signals/outcomes/summary";
import { fresh, signalTurns } from "@/lib/readings/trace-signals/signals/test-fixtures";
import type { SignalTurn } from "@/lib/readings/trace-signals/signals/types";
import type { RunBasis } from "@/lib/readings/trace-signals/workflows/run-basis";

const WINDOW = { start: new Date("2020-01-01T00:00:00Z"), end: new Date("2100-01-01T00:00:00Z") };
const BASIS: RunBasis = { basis: "all", blocked: null, excludedRuns: 0, since: null, mixed: false };

/** The error message of every failed call of `tool`, keyed by the event the step points at. Invented messages. */
function messages(
  turns: readonly SignalTurn[],
  byTool: Record<string, string>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const turn of turns) {
    for (const step of turn.steps) {
      const message = step.outcome === "error" && step.targetId ? byTool[step.targetId] : undefined;
      if (message !== undefined) out.set(step.endTraceEventId ?? step.traceEventId, message);
    }
  }
  return out;
}

interface Store {
  turnRows: Map<string, TurnOutcomeRowDraft>;
  sessionRows: Map<string, SessionOutcomeRowDraft>;
  writes: number;
}

function harness(
  turns: readonly SignalTurn[],
  over: Partial<OutcomeRunDeps> & {
    errors?: ReadonlyMap<string, string>;
    basis?: Partial<RunBasis>;
  } = {},
) {
  const store: Store = { turnRows: new Map(), sessionRows: new Map(), writes: 0 };
  const errors = over.errors ?? new Map<string, string>();
  const ordered = [...turns].sort(
    (a, b) => a.endedAt.getTime() - b.endedAt.getTime() || (a.id < b.id ? -1 : 1),
  );
  const deps: OutcomeRunDeps = {
    listPage: async (_projectId, range, _db, limit = 500) => {
      const from = range.after ? ordered.findIndex((turn) => turn.id === range.after!.id) + 1 : 0;
      const page = ordered.slice(from, from + limit);
      const last = page.at(-1);
      return {
        // Owned: the ledger's page types `endedBy` as present; the fixtures leave it out.
        turns: page as ClosedTurn[],
        next: last ? { endedAtRaw: last.endedAt.toISOString(), id: last.id } : null,
      };
    },
    loadBasis: async () => ({ ...BASIS, ...over.basis }),
    loadErrors: async (_projectId, ids) =>
      new Map(ids.flatMap((id) => (errors.has(id) ? [[id, errors.get(id)!] as const] : []))),
    replaceTurnRows: async (_projectId, _range, rows) => {
      store.writes += 1;
      const sessions = new Set([...store.turnRows.values(), ...rows].map((row) => row.sessionId));
      const inWindow = new Set(ordered.map((turn) => turn.id));
      for (const id of [...store.turnRows.keys()]) if (inWindow.has(id)) store.turnRows.delete(id);
      for (const row of rows) store.turnRows.set(row.turnId, row);
      return { written: rows.length, sessions: [...sessions].sort() };
    },
    loadSessionTurns: async (_projectId, ids) => {
      const out = new Map<string, SessionTurn[]>();
      for (const row of store.turnRows.values()) {
        if (!ids.includes(row.sessionId)) continue;
        out.set(row.sessionId, [
          ...(out.get(row.sessionId) ?? []),
          { ...row, streaks: row.failures.length },
        ]);
      }
      return out;
    },
    replaceSessionRows: async (_projectId, ids, rows) => {
      for (const id of ids) store.sessionRows.delete(id);
      for (const row of rows) store.sessionRows.set(row.sessionId, row);
      return rows.length;
    },
    now: () => new Date(1_000),
    timeBudgetMs: 60_000,
    startedAt: 0,
    pageSize: 500,
    ...over,
  };
  return { store, deps, run: () => recordOutcomes("project", { window: WINDOW }, deps) };
}

/** Five runs, each its own session: fixed on the next try, switched, gave up, searched and found nothing, clean. */
function fiveTurns(): SignalTurn[] {
  return signalTurns([
    fresh({ session: "fixed" })
      .invoke("create_invoice")
      .error("create_invoice")
      .invoke("create_invoice"),
    fresh({ session: "switched" })
      .invoke("find_invoice")
      .error("find_invoice")
      .invoke("list_invoices"),
    fresh({ session: "gave-up" })
      .search(["send_invoice"])
      .invoke("send_invoice")
      .error("send_invoice"),
    fresh({ session: "searched" }).search([]),
    fresh({ session: "clean" }).search(["a"]).invoke("a"),
  ]);
}

const MESSAGES = {
  create_invoice: "validation_failed",
  find_invoice: "Invoice not found",
  send_invoice: "operation_failed",
};

test("a window's turns become rows: each streak with its cause and what followed, and the counts", async () => {
  const turns = fiveTurns();
  const { store, run } = harness(turns, { errors: messages(turns, MESSAGES) });
  const { stored } = await run();

  const bySession = new Map([...store.turnRows.values()].map((row) => [row.sessionId, row]));
  assert.deepEqual(bySession.get("fixed")?.failures, [
    {
      tool: "create_invoice",
      ordinal: 1,
      errors: 1,
      cause: "bad_arguments",
      followed: "fixed_next_try",
      recovered: true,
    },
  ]);
  assert.deepEqual(
    [
      bySession.get("switched")?.cause,
      bySession.get("switched")?.followed,
      bySession.get("switched")?.okCalls,
    ],
    ["wrong_reference", "switched_tool", 1],
  );
  assert.deepEqual(
    [bySession.get("gave-up")?.cause, bySession.get("gave-up")?.followed],
    ["tool_fault", "nothing_followed"],
  );
  assert.deepEqual(
    [
      bySession.get("searched")?.unmetSearches,
      bySession.get("searched")?.cause,
      bySession.get("searched")?.followed,
    ],
    [1, null, null],
  );
  assert.deepEqual(bySession.get("clean")?.failures, []);

  assert.deepEqual(stored, {
    version: 1,
    ruleVersion: OUTCOME_RULE_VERSION,
    trust: { runs: "all", sessions: true },
    turns: 5,
    sessions: 5,
    failedCalls: 3,
    errorsUnread: 0,
    causes: { bad_arguments: 1, wrong_reference: 1, tool_fault: 1, not_allowed: 0, other: 0 },
    otherShapes: 0,
    streaks: 3,
    followed: { fixed_next_try: 1, fixed_after_detour: 0, switched_tool: 1, nothing_followed: 1 },
    unmetSearches: 1,
    catalogListings: 0,
    openRequests: 2,
    fusion: {
      results: { completed: 3, completed_wrong: 0, failed: 2, refused: 0 },
      falseCompletions: 0,
      sessions: {
        resolved_clean: 1,
        resolved_after_friction: 2,
        gave_up: 1,
        blocked: 1,
        escalated: 0,
      },
      ruleOnlySessions: 5,
    },
    questionsOff: "no_key",
  } satisfies StoredOutcomes);
  assert.deepEqual(
    [...store.sessionRows.values()]
      .filter((row) => row.openRequest)
      .map((row) => row.sessionId)
      .sort(),
    ["gave-up", "searched"],
  );
});

test("the words and later calls of a search are loaded only for turns that ran nothing after it, and later calls only where sessions are one person's", async () => {
  const turns = signalTurns([
    fresh({ session: "open" }).search(["create_task"], { query: "delete task" }),
    fresh({ session: "ran" }).search(["create_task"]).invoke("create_task"),
  ]);
  const event = turns[0]!.steps[0]!.traceEventId;
  const asked: unknown[] = [];
  const deps = {
    loadSearchQueries: async (_projectId: string, ids: readonly string[]) => {
      asked.push(ids);
      return new Map([[event, "delete task"]]);
    },
    loadLastCalls: async (_projectId: string, ids: readonly string[]) => {
      asked.push(ids);
      return new Map<string, Map<string, Date>>();
    },
  };
  const trusted = harness(turns, deps);
  assert.equal((await trusted.run()).stored.unmetSearches, 1);
  assert.deepEqual(asked.splice(0), [[event], ["open"]]);

  const mixed = harness(turns, { ...deps, basis: { mixed: true } });
  assert.equal((await mixed.run()).stored.unmetSearches, 0);
  assert.deepEqual(asked.splice(0), [[event]]);

  const none = harness([turns[1]!], deps);
  await none.run();
  assert.deepEqual(asked, []);
});

test("a streak takes its most common cause; an unknown message is other, a missing one is unread", async () => {
  const turns = signalTurns([
    fresh({ session: "mixed" })
      .invoke("a")
      .error("a")
      .invoke("a")
      .error("a")
      .invoke("a")
      .error("a"),
    fresh({ session: "odd" }).invoke("b").error("b"),
    fresh({ session: "gone" }).invoke("c").error("c"),
  ]);
  const errors = messages(turns, { b: "Something odd happened" });
  const failed = turns[0]!.steps
    .filter((step) => step.outcome === "error")
    .map((step) => step.endTraceEventId ?? step.traceEventId);
  ["Record not found", "validation_failed", "validation_failed"].forEach((message, i) => {
    errors.set(failed[i]!, message);
  });
  const { store, run } = harness(turns, { errors });
  const { stored } = await run();

  const bySession = new Map([...store.turnRows.values()].map((row) => [row.sessionId, row]));
  assert.deepEqual(
    [bySession.get("mixed")?.cause, bySession.get("mixed")?.failures[0]?.errors],
    ["bad_arguments", 3],
  );
  assert.deepEqual([bySession.get("odd")?.cause, bySession.get("odd")?.errorsUnread], ["other", 0]);
  assert.deepEqual(
    [
      bySession.get("gone")?.cause,
      bySession.get("gone")?.errorsUnread,
      bySession.get("gone")?.followed,
    ],
    [null, 1, "nothing_followed"],
  );
  assert.deepEqual(stored.causes, {
    bad_arguments: 2,
    wrong_reference: 1,
    tool_fault: 0,
    not_allowed: 0,
    other: 1,
  });
  assert.deepEqual([stored.failedCalls, stored.errorsUnread, stored.otherShapes], [5, 1, 1]);
});

test("reading the same window again gives the same rows and the same counts", async () => {
  const turns = fiveTurns();
  const { store, run } = harness(turns, { errors: messages(turns, MESSAGES), pageSize: 2 });
  const first = await run();
  const rows = structuredClone([...store.turnRows.values()]);
  const sessions = structuredClone([...store.sessionRows.values()]);
  const second = await run();
  assert.deepEqual(second, first);
  assert.deepEqual([...store.turnRows.values()], rows);
  assert.deepEqual([...store.sessionRows.values()], sessions);
});

test("out of time: the walk stops and nothing is written", async () => {
  const turns = fiveTurns();
  // Two pages; the clock is past the budget when the first page is done.
  const { store, run } = harness(turns, {
    pageSize: 3,
    now: () => new Date(10_000),
    timeBudgetMs: 5_000,
  });
  await assert.rejects(run(), TimeBudgetError);
  assert.equal(store.writes, 0);
  assert.equal(store.turnRows.size, 0);
});

test("mixed runs: no turn is read, and the window's earlier rows go", async () => {
  const turns = fiveTurns();
  const { store, deps, run } = harness(turns, { errors: messages(turns, MESSAGES) });
  await run();
  assert.equal(store.turnRows.size, 5);
  const { stored } = await recordOutcomes(
    "project",
    { window: WINDOW },
    { ...deps, loadBasis: async () => ({ ...BASIS, blocked: "mixed_runs", mixed: true }) },
  );
  assert.deepEqual([stored.turns, stored.sessions, stored.trust.runs], [0, 0, "none"]);
  assert.equal(store.turnRows.size, 0);
  assert.equal(store.sessionRows.size, 0);
});

test("sessions that are not one user's: turns are read, sessions are not folded", async () => {
  const turns = fiveTurns();
  const { store, run } = harness(turns, {
    errors: messages(turns, MESSAGES),
    basis: { mixed: true },
  });
  const { stored } = await run();
  assert.deepEqual(
    [stored.turns, stored.sessions, stored.openRequests, stored.trust.sessions],
    [5, 0, 0, false],
  );
  assert.equal(store.turnRows.size, 5);
  assert.equal(store.sessionRows.size, 0);
});

test("a session is folded from every stored turn row, the ones before the window included", async () => {
  const [turn] = signalTurns([fresh({ session: "long" }).invoke("a").error("a")]);
  const { store, run } = harness([turn!]);
  const earlier: TurnOutcomeRowDraft = {
    turnId: "turn-before-window",
    sessionId: "long",
    startedAt: new Date(turn!.startedAt.getTime() - 3_600_000),
    endedAt: new Date(turn!.startedAt.getTime() - 3_500_000),
    cause: null,
    followed: null,
    failures: [],
    okCalls: 2,
    failedCalls: 0,
    errorsUnread: 0,
    unmetSearches: 1,
    catalogListings: 0,
  };
  store.turnRows.set(earlier.turnId, earlier);
  await run();
  const session = store.sessionRows.get("long");
  assert.deepEqual(
    [
      session?.turnCount,
      session?.firstTurnId,
      session?.lastTurnId,
      session?.frictionCount,
      session?.openRequest,
    ],
    [2, "turn-before-window", turn!.id, 2, true],
  );
});

test("the stored counts read back and print as lines, counts only", async () => {
  const turns = fiveTurns();
  const { run } = harness(turns, {
    errors: messages(turns, { ...MESSAGES, send_invoice: "Something odd happened" }),
  });
  const { stored } = await run();
  assert.deepEqual(storedOutcomesOf({ outcomes: JSON.parse(JSON.stringify(stored)) }), stored);
  assert.equal(storedOutcomesOf({}), null);
  assert.equal(storedOutcomesOf({ outcomes: { version: 2 } }), null);
  assert.deepEqual(outcomeLines(stored), [
    `outcomes: 5 turns and 5 sessions read (rules v${OUTCOME_RULE_VERSION}, no model: no Sage key)`,
    "failed calls 3 by cause: bad arguments 1, wrong reference 1, tool fault 0, not allowed 0, other 1 in 1 unknown shape; 0 without a readable message",
    "failure streaks 3: fixed on the next try 1, fixed after a detour 0, switched tool 1, nothing followed 1",
    "searches no tool fits 1, catalog listings 0, sessions left with an open request 2",
    "turn results: completed 3, completed wrong 0, failed 2, refused 0; said done over an error 0",
    "session outcomes: resolved cleanly 1, resolved after friction 2, gave up 1, blocked 1, escalated 0 (5 from the trace alone)",
  ]);
  // A run stored before the fusion reads back with its counts at zero.
  const { fusion: _fusion, ...older } = stored;
  assert.deepEqual(storedOutcomesOf({ outcomes: older })?.fusion, {
    results: { completed: 0, completed_wrong: 0, failed: 0, refused: 0 },
    falseCompletions: 0,
    sessions: {
      resolved_clean: 0,
      resolved_after_friction: 0,
      gave_up: 0,
      blocked: 0,
      escalated: 0,
    },
    ruleOnlySessions: 0,
  });
});
