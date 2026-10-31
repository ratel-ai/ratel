import assert from "node:assert/strict";
import { test } from "node:test";
import type { WindowDays } from "@/lib/readings/trace-signals/view";
import type { ImportSummary } from "@/lib/views/health/imports-types";
import {
  type LedgerDayCount,
  type LedgerFacts,
  ledgerFacts,
  NO_RUNS,
  type RunFacts,
} from "@/lib/views/health/ledger-facts";
import {
  type HealthPageState,
  type HealthStateInputs,
  healthPageState,
  planWithWindow,
  READING_REQUEST_COOLDOWN_MS,
  READING_REQUEST_MAX_COOLDOWN_MS,
  readingRequestDue,
  requestCooldownMs,
  stateReadiness,
} from "@/lib/views/health/page-state";
import { healthStateCopy } from "@/lib/views/health/page-state-copy";

const NOW = new Date("2026-10-15T12:00:00Z");
const MINUTE = 60_000;

/** A `YYYY-MM-DD` day `n` days before NOW. */
function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 86_400_000).toISOString().slice(0, 10);
}

function day(n: number, counts: Partial<Omit<LedgerDayCount, "day">>): LedgerDayCount {
  return { day: daysAgo(n), closed: 0, open: 0, idleOpen: 0, imported: 0, ...counts };
}

function facts(
  rows: readonly LedgerDayCount[] = [],
  extra: { newestClosedAt?: Date | null; unreadClosed?: number; lastRunAt?: Date | null } & Partial<
    Omit<RunFacts, "lastRunAt">
  > = {},
): LedgerFacts {
  const { newestClosedAt = null, unreadClosed = 0, lastRunAt = null, ...runs } = extra;
  return ledgerFacts({
    rows,
    newestClosedAt,
    runs: { ...NO_RUNS, ...runs, lastRunAt: lastRunAt?.toISOString() ?? null },
    unreadClosed,
    now: NOW,
  });
}

function anImport(over: Partial<ImportSummary> = {}): ImportSummary {
  return {
    id: "imp-1",
    source: "langfuse",
    status: "completed",
    label: "127.0.0.1:3999",
    windowDays: 7,
    itemsRead: 180,
    runsImported: 60,
    truncated: false,
    failure: null,
    failureDetail: null,
    startedAt: "2026-10-12T11:24:39.188Z",
    finishedAt: "2026-10-12T11:24:51.416Z",
    relay: false,
    ...over,
  };
}

function state(over: Partial<HealthStateInputs> = {}): HealthPageState {
  return healthPageState({
    windowDays: 7,
    readingTurns: 0,
    floor: 50,
    ledger: facts(),
    imports: [],
    planWindowDays: 90,
    ...over,
  });
}

const copyOf = (s: HealthPageState, windowDays: WindowDays = 7) =>
  healthStateCopy(s, { windowDays, now: NOW });

test("a reading with enough turns is the page, whatever the ledger and the imports say", () => {
  assert.deepEqual(state({ readingTurns: 50 }), { kind: "ready" });
  assert.deepEqual(
    state({
      readingTurns: 344,
      imports: [anImport({ status: "running" })],
      ledger: facts([day(6, { open: 60, imported: 60 })]),
    }),
    { kind: "ready" },
  );
});

test("nothing yet: no turns anywhere and no import bringing any", () => {
  assert.deepEqual(state(), { kind: "nothing_yet" });
  // An import that found nothing brings nothing: its row says why.
  assert.deepEqual(state({ imports: [anImport({ runsImported: 0, failure: "nothing_found" })] }), {
    kind: "nothing_yet",
  });
  assert.deepEqual(state({ imports: [anImport({ status: "waiting", runsImported: 0 })] }), {
    kind: "nothing_yet",
  });
  const copy = copyOf(state());
  assert.equal(copy.title, "No runs yet");
  assert.match(copy.body, /Import past runs/);
  assert.match(copy.body, /API key/);
});

test("the reported bug: 60 imported runs no reading counts are being built, never 'no turns'", () => {
  // Oct 9, imported on Oct 12 and still open: the 7 day reading anchored on that run has 0 turns.
  const ledger = facts(
    [day(6, { open: 60, idleOpen: 60, imported: 60 }), day(31, { closed: 284 })],
    {
      lastRunAt: new Date("2026-10-12T11:41:53.977Z"),
    },
  );
  const s = state({ ledger, imports: [anImport(), anImport({ id: "imp-2" })] });
  assert.deepEqual(s, {
    kind: "building",
    phase: "computing",
    turns: 60,
    imported: true,
    source: null,
    working: false,
  });
  assert.equal(copyOf(s).title, "Building your reading from 60 imported runs…");
  assert.equal(copyOf(s).body, "It starts within a few minutes. The page updates on its own.");
  const queued = { ...(s as Extract<HealthPageState, { kind: "building" }>), working: true };
  assert.equal(copyOf(queued).body, "This takes about a minute. The page updates on its own.");
  assert.equal(
    readingRequestDue(s, ledger, NOW),
    true,
    "nothing is on its way: the page asks for the reading",
  );
  assert.equal(stateReadiness(s), "collecting");
});

test("building: turns the reading has not read are computed; runs still in progress wait for their build", () => {
  const closed = state({ ledger: facts([day(1, { closed: 70 })], { unreadClosed: 70 }) });
  assert.equal(closed.kind === "building" && closed.phase, "computing");
  assert.equal(closed.kind === "building" && closed.imported, false);
  assert.equal(copyOf(closed).title, "Building your reading from 70 turns…");

  const live = facts([day(0, { open: 70 })]);
  const inProgress = state({ ledger: live });
  assert.equal(inProgress.kind === "building" && inProgress.phase, "finishing");
  assert.equal(
    readingRequestDue(inProgress, live, NOW),
    false,
    "nothing to compute until they finish",
  );
  assert.match(copyOf(inProgress).body, /still in progress/);

  const queued = state({ ledger: facts([day(0, { open: 70 })], { working: true }) });
  assert.equal(
    queued.kind === "building" && queued.phase,
    "computing",
    "a queued signal run is computing already",
  );
  assert.match(copyOf(queued).body, /updates on its own/);
});

test("a reading that has read every turn and still counts too few says so, and asks for nothing", () => {
  // Turn ids arrived, so the reading leaves the guessed turns out: it read all 70 and counts 20.
  const ledger = facts([day(1, { closed: 70 })], {
    unreadClosed: 0,
    lastRunAt: new Date(NOW.getTime() - 60 * MINUTE),
  });
  const s = state({ ledger, readingTurns: 20 });
  assert.deepEqual(s, { kind: "too_few", turns: 20, floor: 50, imported: false, wider: null });
  assert.equal(readingRequestDue(s, ledger, NOW), false);
  assert.equal(copyOf(s).title, "20 turns in the last 7\u00a0days");

  // One turn written after that reading started is enough to read again.
  const fresh = facts([day(1, { closed: 70 })], {
    unreadClosed: 1,
    lastRunAt: new Date(NOW.getTime() - 60 * MINUTE),
  });
  const again = state({ ledger: fresh, readingTurns: 20 });
  assert.equal(again.kind === "building" && again.phase, "computing");
  assert.equal(readingRequestDue(again, fresh, NOW), true);
});

test("importing: an import storing runs reads as one, with its progress", () => {
  const s = state({
    imports: [anImport({ status: "running", runsImported: 40, finishedAt: null })],
  });
  assert.deepEqual(s, {
    kind: "building",
    phase: "importing",
    turns: 40,
    imported: true,
    source: "langfuse",
    working: true,
  });
  assert.equal(copyOf(s).title, "Importing runs from Langfuse…");
  assert.match(copyOf(s).body, /^40 runs so far\./);
  assert.equal(readingRequestDue(s, facts(), NOW), false, "the import asks for its own reading");
  const starting = copyOf(state({ imports: [anImport({ status: "running", runsImported: 0 })] }));
  assert.match(starting.body, /^Reading runs from the source\./);
});

test("an import whose runs are stored but not built yet is being built, not nothing", () => {
  const s = state({ imports: [anImport()] });
  assert.deepEqual(s, {
    kind: "building",
    phase: "computing",
    turns: 60,
    imported: true,
    source: "langfuse",
    working: false,
  });
  assert.equal(readingRequestDue(s, facts(), NOW), true);
  const before = facts([], {
    lastRunAt: new Date("2026-10-12T11:00:00Z"),
    lastCompletedAt: "2026-10-12T11:00:00.000Z",
  });
  assert.equal(
    state({ imports: [anImport()], ledger: before }).kind,
    "building",
    "a run from before the import has not read it",
  );
  // A run after the import that failed has not read it either: it is retried, not "no tool calls".
  const failedAfter = facts([], {
    lastRunAt: new Date("2026-10-12T11:25:00Z"),
    lastRunStatus: "failed",
    failedRuns: 1,
  });
  const stalled = state({ imports: [anImport()], ledger: failedAfter });
  assert.equal(stalled.kind === "building" && stalled.phase, "stalled");
});

test("an import whose runs a later reading found no turns in called no tools: said so, never 'no runs yet'", () => {
  const after = facts([], {
    lastRunAt: new Date("2026-10-12T11:24:51.519Z"),
    lastCompletedAt: "2026-10-12T11:24:51.519Z",
    lastRunStatus: "completed",
  });
  const s = state({ imports: [anImport()], ledger: after });
  assert.deepEqual(s, { kind: "imported_no_tools", runs: 60, source: "langfuse" });
  assert.equal(readingRequestDue(s, after, NOW), false, "nothing to ask for again");
  assert.equal(stateReadiness(s), "no_telemetry");
  const copy = copyOf(s);
  assert.equal(copy.title, "Your imported runs have no tool calls");
  assert.match(copy.body, /none of the 60 runs imported from Langfuse called one/);
  assert.match(copy.body, /Import runs that call tools/);
  assert.match(
    healthStateCopy(
      { kind: "imported_no_tools", runs: 1, source: "postgres" },
      { windowDays: 7, now: NOW },
    ).body,
    /the 1 run imported from Postgres called none/,
  );
  assert.doesNotMatch(
    healthStateCopy(s, { windowDays: 7, now: NOW, canImport: false }).body,
    /Import runs/,
  );

  // While a reading is still running, it is still being built.
  assert.equal(
    state({
      imports: [anImport()],
      ledger: facts([], {
        lastRunAt: NOW,
        lastCompletedAt: "2026-10-12T11:24:51.519Z",
        working: true,
      }),
    }).kind,
    "building",
  );
  // Live model calls without tool spans have their own notice, which says more.
  assert.equal(
    state({ imports: [anImport()], ledger: after, waitingOn: "tool_spans" }).kind,
    "tool_spans",
  );
});

test("a reading that did not load says so", () => {
  const s: HealthPageState = { kind: "unavailable" };
  assert.equal(stateReadiness(s), "no_telemetry");
  assert.equal(readingRequestDue(s, facts(), NOW), false);
  assert.deepEqual(copyOf(s), {
    title: "The reading did not load",
    body: "Something went wrong on our side. Reload the page to try again.",
  });
});

test("an import held for our team is being finished, never nothing", () => {
  const s = state({
    imports: [anImport({ status: "received", runsImported: 0, failure: "storage" })],
  });
  assert.deepEqual(s, {
    kind: "building",
    phase: "held",
    turns: 0,
    imported: true,
    source: "langfuse",
    working: false,
  });
  assert.equal(copyOf(s).title, "We are finishing your Langfuse import");
  assert.equal(readingRequestDue(s, facts(), NOW), false);
});

test("outside the window: when the runs are from, and the window that holds them", () => {
  // The same 60 imported runs, two days later: Oct 9 has left the 7 day window.
  const later = new Date("2026-10-17T12:00:00Z");
  const ledger = ledgerFacts({
    rows: [{ day: "2026-10-09", closed: 60, open: 0, idleOpen: 0, imported: 60 }],
    newestClosedAt: new Date("2026-10-09T12:23:35Z"),
    now: later,
  });
  const s = state({ ledger });
  assert.deepEqual(s, {
    kind: "outside_window",
    turns: 60,
    imported: true,
    firstDay: "2026-10-09",
    lastDay: "2026-10-09",
    suggestion: { days: 30, plan: null },
  });
  const copy = healthStateCopy(s, { windowDays: 7, now: later });
  assert.equal(copy.title, "No runs in the last 7\u00a0days");
  assert.equal(copy.body, "Your 60 imported runs are from Oct 9.");
  assert.equal(stateReadiness(s), "no_telemetry");
});

test("outside the window on limits without the window that holds the runs: suggests it, names no plan", () => {
  // No plan table in this edition: the wider window is offered, never a plan to buy.
  const ledger = facts([day(20, { closed: 30 }), day(40, { closed: 5 })]);
  const free = state({ ledger, planWindowDays: 7 });
  assert.equal(free.kind === "outside_window" && free.suggestion?.days, 30);
  assert.equal(free.kind === "outside_window" && free.suggestion?.plan, null);
  assert.equal(copyOf(free).body, `Your 30 turns are from ${dayText(20)}.`);

  const plus = state({
    ledger: facts([day(40, { closed: 5 }), day(60, { closed: 3 })]),
    windowDays: 30,
    planWindowDays: 30,
  });
  assert.equal(plus.kind === "outside_window" && plus.suggestion?.plan, null);
  assert.match(
    copyOf(plus, 30).body,
    new RegExp(`^Your 8 turns are from ${dayText(60)} to ${dayText(40)}\\.$`),
  );
});

test("outside every window: says how old the latest runs are, and how to get new ones", () => {
  const ledger = facts([], { newestClosedAt: new Date("2026-06-02T10:00:00Z") });
  const s = state({ ledger });
  assert.deepEqual(s, {
    kind: "outside_window",
    turns: 0,
    imported: false,
    firstDay: null,
    lastDay: "2026-06-02",
    suggestion: null,
  });
  assert.equal(
    copyOf(s).body,
    "Your agent's latest runs are from Jun 2. Send new runs with your API key, or import recent ones.",
  );
});

test("too few: how many there are, how many a reading needs, and a wider window that has enough", () => {
  const s = state({ ledger: facts([day(2, { closed: 12 })]) });
  assert.deepEqual(s, { kind: "too_few", turns: 12, floor: 50, imported: false, wider: null });
  assert.equal(copyOf(s).title, "12 turns in the last 7\u00a0days");
  assert.equal(copyOf(s).body, "A reading needs 50. It appears on its own once there are enough.");

  const ledger = facts([day(2, { closed: 12 }), day(20, { closed: 60 })]);
  const wider = state({ ledger });
  assert.deepEqual(wider, {
    kind: "too_few",
    turns: 12,
    floor: 50,
    imported: false,
    wider: { days: 30, plan: null },
  });
  assert.equal(copyOf(wider).body, "A reading needs 50. The last 30\u00a0days have enough.");
  const locked = state({ ledger, planWindowDays: 7 });
  assert.equal(locked.kind === "too_few" && locked.wider?.plan, null, "no plan to name here");
  assert.equal(copyOf(locked).body, "A reading needs 50. The last 30\u00a0days have enough.");
  assert.equal(
    copyOf(state({ ledger: facts([day(1, { closed: 1, imported: 1 })]) })).title,
    "1 imported run in the last 7\u00a0days",
  );
});

test("too few counts what a reading will read: closed turns, not ones still in progress", () => {
  const s = state({ ledger: facts([day(0, { closed: 9, open: 5 })]) });
  assert.deepEqual(s, {
    kind: "too_few",
    turns: 9,
    floor: 50,
    imported: false,
    wider: null,
    inProgress: 5,
  });
  assert.equal(copyOf(s).title, "9 turns in the last 7 days");
  assert.equal(
    copyOf(s).body,
    "5 more are in progress and count once they finish. A reading needs 50. It appears on its own once there are enough.",
  );
  // Nothing finished yet: what the window has is turns in progress, never "0 turns".
  const live = state({ ledger: facts([day(0, { open: 4 })]) });
  assert.deepEqual(live, {
    kind: "too_few",
    turns: 0,
    floor: 50,
    imported: false,
    wider: null,
    inProgress: 4,
  });
  assert.deepEqual(copyOf(live), {
    title: "4 turns in progress",
    body: "A reading needs 50 finished turns. It appears on its own once there are enough.",
  });
  assert.equal(copyOf(state({ ledger: facts([day(0, { open: 1 })]) })).title, "1 turn in progress");
  // A wider window is offered only where its finished turns are enough.
  const wider = state({
    ledger: facts([day(2, { closed: 12 }), day(20, { closed: 30, open: 30 })]),
  });
  assert.equal(wider.kind === "too_few" && wider.wider, null);
});

test("with billing off no plan is named: no plan line, and no wider window that needs one", () => {
  const plans = false;
  const outside = state({ ledger: facts([day(20, { closed: 30 })]), planWindowDays: 7 });
  assert.equal(
    healthStateCopy(outside, { windowDays: 7, now: NOW, plans }).body,
    `Your 30 turns are from ${dayText(20)}.`,
  );
  const tooFew = state({
    ledger: facts([day(2, { closed: 12 }), day(20, { closed: 60 })]),
    planWindowDays: 7,
  });
  // No plan gates the wider window in this edition, so it is offered with billing off too.
  assert.equal(
    healthStateCopy(tooFew, { windowDays: 7, now: NOW, plans }).body,
    "A reading needs 50. The last 30 days have enough.",
  );
  // A window the plan includes needs no plan, billing or not.
  const included = state({ ledger: facts([day(2, { closed: 12 }), day(20, { closed: 60 })]) });
  assert.equal(
    healthStateCopy(included, { windowDays: 7, now: NOW, plans }).body,
    "A reading needs 50. The last 30\u00a0days have enough.",
  );
});

test("imports that could not be read are unknown, not none: never 'nothing yet' on a guess", () => {
  assert.deepEqual(state({ imports: null }), { kind: "unavailable" });
  assert.deepEqual(
    state({ imports: null, waitingOn: "tool_spans" }),
    { kind: "tool_spans" },
    "live model calls are known either way",
  );
  assert.equal(
    state({ imports: null, ledger: facts([day(1, { closed: 3 })]) }).kind,
    "too_few",
    "the ledger still speaks for itself",
  );
});

test("a reading whose runs keep failing says so, and is asked for less and less often", () => {
  const failed = (failedRuns: number, lastRunAt: Date) =>
    facts([day(1, { closed: 70 })], {
      unreadClosed: 70,
      lastRunAt,
      lastRunStatus: "failed",
      failedRuns,
    });
  const once = failed(1, new Date(NOW.getTime() - 15 * MINUTE));
  const s = state({ ledger: once });
  assert.deepEqual(s, {
    kind: "building",
    phase: "stalled",
    turns: 70,
    imported: false,
    source: null,
    working: false,
  });
  assert.deepEqual(copyOf(s), {
    title: "Your reading did not finish",
    body: "It is retried on its own. This page fills in once a reading is done.",
  });
  assert.equal(
    readingRequestDue(s, once, NOW),
    false,
    "after one failure the wait doubles to 20 minutes",
  );
  assert.equal(readingRequestDue(s, failed(1, new Date(NOW.getTime() - 20 * MINUTE)), NOW), true);
  assert.equal(
    readingRequestDue(s, failed(3, new Date(NOW.getTime() - 60 * MINUTE)), NOW),
    false,
    "three in a row: 80 minutes",
  );
  assert.equal(requestCooldownMs(0), READING_REQUEST_COOLDOWN_MS);
  assert.equal(requestCooldownMs(2), 4 * READING_REQUEST_COOLDOWN_MS);
  assert.equal(requestCooldownMs(30), READING_REQUEST_MAX_COOLDOWN_MS, "a day at most");

  // A run cut by its time budget did not finish either: the next one reads a
  // shorter window, but nothing starts it before the next ask.
  const budget = state({ ledger: failed(1, new Date(NOW.getTime() - 15 * MINUTE)) });
  assert.equal(budget.kind === "building" && budget.phase, "stalled");
  // A run on its way is being built, whatever failed before it.
  const queued = state({
    ledger: facts([day(1, { closed: 70 })], {
      unreadClosed: 70,
      working: true,
      lastRunStatus: "failed",
      failedRuns: 2,
    }),
  });
  assert.equal(queued.kind === "building" && queued.phase, "computing");
});

test("model calls without tool spans keep their own notice, only while the ledger is empty", () => {
  assert.deepEqual(state({ waitingOn: "tool_spans" }), { kind: "tool_spans" });
  assert.equal(
    state({ waitingOn: "tool_spans", ledger: facts([day(1, { closed: 3 })]) }).kind,
    "too_few",
  );
});

test("never 'nothing yet' while turns or imports exist", () => {
  const ledgers = [
    facts([day(1, { closed: 3 })]),
    facts([day(1, { open: 3 })]),
    facts([day(50, { closed: 3 })]),
    facts([], { newestClosedAt: new Date("2025-01-01T00:00:00Z") }),
  ];
  for (const ledger of ledgers) {
    for (const windowDays of [7, 30, 90] as const) {
      assert.notEqual(
        state({ ledger, windowDays }).kind,
        "nothing_yet",
        JSON.stringify({ windowDays, ledger: ledger.newestDay }),
      );
    }
  }
  for (const item of [
    anImport(),
    anImport({ status: "running", runsImported: 0 }),
    anImport({ status: "received", runsImported: 0 }),
  ]) {
    assert.notEqual(state({ imports: [item] }).kind, "nothing_yet", item.status);
    // Whatever runs have happened since, completed or failed.
    assert.notEqual(
      state({ imports: [item], ledger: facts([], { lastRunAt: NOW }) }).kind,
      "nothing_yet",
      item.status,
    );
    assert.notEqual(
      state({
        imports: [item],
        ledger: facts([], { lastRunAt: NOW, lastCompletedAt: NOW.toISOString() }),
      }).kind,
      "nothing_yet",
      item.status,
    );
    assert.notEqual(
      state({
        imports: [item],
        ledger: facts([], { lastRunAt: NOW, lastRunStatus: "failed", failedRuns: 1 }),
      }).kind,
      "nothing_yet",
      item.status,
    );
  }
});

test("the page asks for a reading once: not while work is queued, not again right after a run", () => {
  const ledger = (lastRunAt: Date | null, working = false) =>
    facts([day(1, { closed: 70 })], { lastRunAt, working, unreadClosed: 70 });
  const due = (l: LedgerFacts) => readingRequestDue(state({ ledger: l }), l, NOW);
  assert.equal(due(ledger(null)), true, "no run yet");
  assert.equal(
    due(ledger(new Date(NOW.getTime() - 2 * MINUTE))),
    false,
    "a run two minutes ago: wait for the cooldown",
  );
  assert.equal(due(ledger(new Date(NOW.getTime() - READING_REQUEST_COOLDOWN_MS))), true);
  assert.equal(due(ledger(null, true)), false, "a signal run is already queued");
  assert.equal(readingRequestDue({ kind: "ready" }, ledger(null), NOW), false);
  assert.equal(
    readingRequestDue(
      { kind: "too_few", turns: 3, floor: 50, imported: false, wider: null },
      ledger(null),
      NOW,
    ),
    false,
  );
});

test("no plan is ever named for a window: this edition has no plan table", () => {
  assert.equal(planWithWindow(7), null);
  assert.equal(planWithWindow(30), null, "no plan table in this edition");
  assert.equal(planWithWindow(90), null);
});

test("no state's words use an em dash, and pending titles end with an ellipsis", () => {
  const states: HealthPageState[] = [
    state(),
    { kind: "unavailable" },
    state({
      imports: [anImport()],
      ledger: facts([], { lastRunAt: NOW, lastCompletedAt: NOW.toISOString() }),
    }),
    state({ ledger: facts([day(1, { closed: 70 })], { unreadClosed: 70 }) }),
    state({
      ledger: facts([day(1, { closed: 70 })], {
        unreadClosed: 70,
        lastRunStatus: "failed",
        failedRuns: 1,
      }),
    }),
    state({ ledger: facts([day(0, { open: 70 })]) }),
    state({ imports: [anImport({ status: "running" })] }),
    state({ imports: [anImport({ status: "received" })] }),
    state({ ledger: facts([day(2, { closed: 12 }), day(20, { closed: 60 })]), planWindowDays: 7 }),
    state({ ledger: facts([day(0, { closed: 9, open: 5 })]) }),
    state({ ledger: facts([day(0, { open: 4 })]) }),
    state({ ledger: facts([day(20, { closed: 30 })]), planWindowDays: 7 }),
    state({ ledger: facts([], { newestClosedAt: new Date("2026-06-02T10:00:00Z") }) }),
  ];
  for (const s of states) {
    const copy = copyOf(s);
    assert.doesNotMatch(`${copy.title} ${copy.body}`, /\u2014/, s.kind);
    if (s.kind === "building" && s.phase !== "held" && s.phase !== "stalled")
      assert.match(copy.title, /…$/, s.kind);
  }
});

function dayText(n: number): string {
  return new Date(`${daysAgo(n)}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
