import assert from "node:assert/strict";
import { test } from "node:test";
import type { ImportSummary } from "@/lib/views/health/imports-types";
import {
  type LedgerFacts,
  ledgerFacts,
  NO_RUNS,
  type RunFacts,
} from "@/lib/views/health/ledger-facts";
import { READING_REQUEST_COOLDOWN_MS } from "@/lib/views/health/page-state";
import {
  loadHealthPageState,
  type PageStateDeps,
  type PageStateInput,
} from "@/lib/views/health/page-state-load";
import { type ReadingRequestDeps, requestHealthReading } from "@/lib/views/health/reading-request";

const NOW = new Date("2026-10-15T12:00:00Z");
const MINUTE = 60_000;
const READ_AT = "2026-10-15T08:00:00.000Z";

/** The reported demo: 60 imported runs on Oct 9, still open, read by no run since Oct 12. */
const DEMO: LedgerFacts = ledgerFacts({
  rows: [
    { day: "2026-10-09", closed: 0, open: 60, idleOpen: 60, imported: 60 },
    { day: "2026-09-14", closed: 26, open: 0, idleOpen: 0, imported: 0 },
  ],
  newestClosedAt: new Date("2026-09-14T20:48:39Z"),
  runs: {
    ...NO_RUNS,
    lastRunAt: "2026-10-12T11:41:53.977Z",
    lastRunStatus: "completed",
    lastCompletedAt: "2026-10-12T11:41:53.977Z",
  },
  now: NOW,
});

const IMPORT: ImportSummary = {
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
};

type Model = PageStateInput["model"];
const NO_READING: Model = { windowDays: 7, turns: 0, floor: 50, computedAt: null };
const READING: Model = { windowDays: 7, turns: 60, floor: 50, computedAt: READ_AT };

function input(over: Partial<PageStateInput> = {}): PageStateInput {
  return {
    projectId: "p1",
    organizationId: "o1",
    model: NO_READING,
    imports: [IMPORT],
    planWindowDays: 90,
    readOnly: false,
    ...over,
  };
}

function deps(
  over: Partial<PageStateDeps> = {},
  runs: RunFacts = { ...NO_RUNS, lastRunAt: READ_AT },
) {
  const calls = {
    facts: [] as { countImported: boolean; windowDays: number }[],
    runs: 0,
    requests: [] as string[],
  };
  const fakes: Partial<PageStateDeps> = {
    loadFacts: async (_id, options) => {
      calls.facts.push({ countImported: options.countImported, windowDays: options.windowDays });
      return DEMO;
    },
    loadRuns: async () => {
      calls.runs += 1;
      return runs;
    },
    requestReading: async (request) => {
      calls.requests.push(request.reason);
      return true;
    },
    now: () => NOW,
    ...over,
  };
  return { calls, fakes };
}

test("a page whose reading has enough turns reads nothing more", async () => {
  const { calls, fakes } = deps();
  const state = await loadHealthPageState(input({ model: READING }), fakes);
  assert.deepEqual(state, { kind: "ready" });
  assert.deepEqual(calls, { facts: [], runs: 0, requests: [] });
});

test("a live turn count with no computed reading is not a reading: it is being built, and watched", async () => {
  // Before a first run the model counts closed turns live: 60 of them, and no tiles.
  const { calls, fakes } = deps({
    loadFacts: async () =>
      ledgerFacts({
        rows: [{ day: "2026-10-14", closed: 60, open: 0, idleOpen: 0, imported: 0 }],
        newestClosedAt: new Date("2026-10-14T10:00:00Z"),
        unreadClosed: 60,
        now: NOW,
      }),
  });
  const state = await loadHealthPageState(
    input({ model: { ...NO_READING, turns: 60 }, imports: [] }),
    fakes,
  );
  assert.deepEqual(state, {
    kind: "building",
    phase: "computing",
    turns: 60,
    imported: false,
    source: null,
    working: true,
  });
  assert.deepEqual(calls.requests, ["turns_unread"]);
});

test("the reported page: building from the imported runs, and the reading is asked for", async () => {
  const { calls, fakes } = deps();
  const state = await loadHealthPageState(input(), fakes);
  assert.deepEqual(state, {
    kind: "building",
    phase: "computing",
    turns: 60,
    imported: true,
    source: null,
    working: true,
  });
  assert.deepEqual(
    calls.facts,
    [{ countImported: true, windowDays: 7 }],
    "the ledger is read for the selected window",
  );
  assert.deepEqual(calls.requests, ["imported_runs_unread"]);
});

test("a reading that started while turns were still being built asks for one that reads them, and watches", async () => {
  const partial: Model = { ...READING, unbuiltAtReading: 180 };
  const asked = deps();
  assert.deepEqual(await loadHealthPageState(input({ model: partial }), asked.fakes), {
    kind: "ready",
    updating: true,
  });
  assert.deepEqual(asked.calls.requests, ["reading_partial"]);
  assert.deepEqual(asked.calls.facts, [], "the ledger is not read for a page with a reading");

  // Already on its way: watch, ask nothing.
  const working = deps({}, { ...NO_RUNS, working: true, lastRunAt: NOW.toISOString() });
  assert.deepEqual(await loadHealthPageState(input({ model: partial }), working.fakes), {
    kind: "ready",
    updating: true,
  });
  assert.deepEqual(working.calls.requests, []);

  // Asked a minute ago and nothing queued (the run failed early): the cooldown holds; the page is the reading.
  const recent = deps(
    {},
    { ...NO_RUNS, lastRunAt: new Date(NOW.getTime() - MINUTE).toISOString() },
  );
  assert.deepEqual(await loadHealthPageState(input({ model: partial }), recent.fakes), {
    kind: "ready",
  });
  assert.deepEqual(recent.calls.requests, []);

  // An admin support session only looks.
  const support = deps();
  assert.deepEqual(
    await loadHealthPageState(input({ model: partial, readOnly: true }), support.fakes),
    { kind: "ready" },
  );
  assert.deepEqual(support.calls.requests, []);

  // The runs could not be read: the reading is still the page.
  const unreadable = deps({ loadRuns: async () => null });
  assert.deepEqual(await loadHealthPageState(input({ model: partial }), unreadable.fakes), {
    kind: "ready",
  });
});

test("an admin support session decides the same state but never asks for work", async () => {
  const { calls, fakes } = deps();
  const state = await loadHealthPageState(input({ readOnly: true }), fakes);
  assert.equal(state?.kind === "building" && state.working, false);
  assert.deepEqual(calls.requests, []);
});

test("a failed request leaves the state as it was", async () => {
  const failed = deps({ requestReading: async () => false });
  const state = await loadHealthPageState(input(), failed.fakes);
  assert.equal(state?.kind === "building" && state.working, false);
});

test("a failed read is never taken for an empty project, and never asks for work", async () => {
  // The reading itself did not load: the model is the empty fallback.
  const fallback = deps();
  assert.deepEqual(await loadHealthPageState(input({ modelUnavailable: true }), fallback.fakes), {
    kind: "unavailable",
  });
  assert.deepEqual(fallback.calls, { facts: [], runs: 0, requests: [] });

  // The ledger did not load: with no turns in the reading, nothing true can be said but that.
  const unreadable = deps({ loadFacts: async () => null });
  assert.deepEqual(await loadHealthPageState(input(), unreadable.fakes), { kind: "unavailable" });
  // Some turns, fewer than a reading needs: the model's own "collecting" is true.
  assert.equal(
    await loadHealthPageState(input({ model: { ...READING, turns: 14 } }), unreadable.fakes),
    null,
  );
  // A live count past the floor with no reading would read as a reading: not that either.
  assert.deepEqual(
    await loadHealthPageState(input({ model: { ...NO_READING, turns: 60 } }), unreadable.fakes),
    { kind: "unavailable" },
  );
  assert.deepEqual(unreadable.calls.requests, []);
});

test("imports that could not be read are passed on as unknown", async () => {
  const counted: boolean[] = [];
  const empty = deps({
    loadFacts: async (_id, options) => {
      counted.push(options.countImported);
      return ledgerFacts({ rows: [], newestClosedAt: null, now: NOW });
    },
  });
  assert.deepEqual(await loadHealthPageState(input({ imports: null }), empty.fakes), {
    kind: "unavailable",
  });
  assert.deepEqual(await loadHealthPageState(input({ imports: [] }), empty.fakes), {
    kind: "nothing_yet",
  });
  assert.deepEqual(counted, [false, false], "no imported turns to count either way");
});

test("the request rides on a build that asks for the run once it has caught up, drained after the response, and tracked", async () => {
  const log: string[] = [];
  const tracked: { event: string; properties: Record<string, unknown> }[] = [];
  const fakes: Partial<ReadingRequestDeps> = {
    enqueueBuild: async (_id, reading) => {
      log.push(`build:${reading}`);
      return { id: "b" };
    },
    scheduleDrain: () => void log.push("drain"),
    trackServerEvent: async (event, _context, properties = {}) =>
      void tracked.push({ event, properties }),
    now: () => NOW,
    recent: new Map(),
  };
  const ok = await requestHealthReading(
    { projectId: "p1", organizationId: "o1", reason: "turns_unread" },
    fakes,
  );
  assert.equal(ok, true);
  assert.deepEqual(
    log,
    ["build:manual", "drain"],
    "no run is enqueued beside the build to race it",
  );
  assert.equal(tracked[0]?.event, "trace_signal_run_requested");
  assert.equal(tracked[0]?.properties.object_action, "trace_signal_run_requested");
  assert.equal(tracked[0]?.properties.build_queued, true);
});

test("this process asks at most once per cooldown per project: claimed before it asks, kept when the ask fails", async () => {
  const recent = new Map<string, number>();
  const enqueued: string[] = [];
  const reported: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const at = (ms: number) => () => new Date(NOW.getTime() + ms);
  const fakes = (now: () => Date, fail = false): Partial<ReadingRequestDeps> => ({
    enqueueBuild: async (id) => {
      enqueued.push(id);
      await gate;
      if (fail) throw new Error("connection reset");
      return { id: "b" };
    },
    scheduleDrain: () => {},
    trackServerEvent: async () => {},
    reportServerException: (_err, _distinctId, properties) =>
      void reported.push(String(properties?.operation)),
    now,
    recent,
  });
  const ask = (projectId: string, now: () => Date, fail = false) =>
    requestHealthReading(
      { projectId, organizationId: "o1", reason: "turns_unread" },
      fakes(now, fail),
    );

  // Two renders at once: the second sees the first's claim before the first has enqueued anything.
  const first = ask("p1", at(0));
  const second = ask("p1", at(10));
  release();
  assert.deepEqual(await Promise.all([first, second]), [true, false]);
  assert.equal(await ask("p2", at(5_000)), true, "another project is its own");
  assert.equal(await ask("p1", at(READING_REQUEST_COOLDOWN_MS)), true, "after the cooldown it may");

  // A failed ask is reported once; a poll five seconds later does not retry it.
  assert.equal(await ask("p3", at(0), true), false);
  assert.equal(await ask("p3", at(5_000), true), false);
  assert.deepEqual(reported, ["agent_health_reading_request"]);
  assert.deepEqual(enqueued, ["p1", "p2", "p1", "p3"]);
});
