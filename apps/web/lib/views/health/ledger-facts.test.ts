import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ledgerFacts,
  ledgerWindowStart,
  mergeDayCounts,
  NO_RUNS,
  runFacts,
} from "@/lib/views/health/ledger-facts";

const NOW = new Date("2026-10-15T12:00:00Z");

test("the three per-day reads merge into one row per day, oldest first", () => {
  const rows = mergeDayCounts({
    closed: [
      { day: "2026-10-09", n: 4 },
      { day: "2026-09-14", n: 26 },
    ],
    open: [{ day: "2026-10-09", n: 60, idle: 59 }],
    imported: [{ day: "2026-10-09", n: 60 }],
  });
  assert.deepEqual(rows, [
    { day: "2026-09-14", closed: 26, open: 0, idleOpen: 0, imported: 0 },
    { day: "2026-10-09", closed: 4, open: 60, idleOpen: 59, imported: 60 },
  ]);
});

test("windows are whole UTC days, as the reading's own: 7 days is today and the six before", () => {
  const facts = ledgerFacts({
    rows: [
      { day: "2026-10-09", closed: 10, open: 2, idleOpen: 1, imported: 12 },
      { day: "2026-10-08", closed: 5, open: 0, idleOpen: 0, imported: 0 },
      { day: "2026-09-16", closed: 7, open: 0, idleOpen: 0, imported: 0 },
      { day: "2026-07-18", closed: 1, open: 0, idleOpen: 0, imported: 0 },
    ],
    newestClosedAt: new Date("2026-10-09T12:00:00Z"),
    now: NOW,
  });
  assert.deepEqual(facts.windows[7], {
    turns: 12,
    closed: 10,
    idleOpen: 1,
    imported: 12,
    firstDay: "2026-10-09",
    lastDay: "2026-10-09",
  });
  assert.equal(facts.windows[30].turns, 24, "Sep 16 is the first of the 30 days");
  assert.equal(facts.windows[30].firstDay, "2026-09-16");
  assert.equal(facts.windows[90].turns, 25, "Jul 18 is the first of the 90 days");
  assert.equal(facts.newestDay, "2026-10-09");
  assert.equal(ledgerWindowStart(NOW, 7).toISOString(), "2026-10-09T00:00:00.000Z");
  assert.equal(ledgerWindowStart(NOW, 90).toISOString(), "2026-07-18T00:00:00.000Z");
});

test("the newest turn may be older than every window; days without turns do not count", () => {
  const runs = { ...NO_RUNS, working: true, lastRunAt: "2026-10-12T11:41:53.977Z" };
  const facts = ledgerFacts({
    rows: [{ day: "2026-10-14", closed: 0, open: 0, idleOpen: 0, imported: 0 }],
    newestClosedAt: new Date("2026-03-02T08:00:00Z"),
    runs,
    now: NOW,
  });
  assert.equal(facts.windows[90].turns, 0);
  assert.equal(facts.windows[7].firstDay, null);
  assert.equal(facts.newestDay, "2026-03-02");
  assert.equal(facts.working, true);
  assert.equal(facts.lastRunAt, "2026-10-12T11:41:53.977Z");
  assert.equal(facts.unreadClosed, 0, "unread defaults to nothing");
  const empty = ledgerFacts({ rows: [], newestClosedAt: null, now: NOW });
  assert.equal(empty.newestDay, null);
  assert.deepEqual(
    [empty.working, empty.lastRunAt, empty.lastCompletedAt, empty.failedRuns],
    [false, null, null, 0],
    "no runs by default",
  );
  assert.equal(
    ledgerFacts({ rows: [], newestClosedAt: null, unreadClosed: 7, now: NOW }).unreadClosed,
    7,
  );
});

test("run facts: the latest run times the cooldown; failures in a row count until a completed one", () => {
  const at = (iso: string) => new Date(iso);
  const rows = [
    { status: "running", createdAt: at("2026-10-15T11:59:00Z") },
    { status: "failed", createdAt: at("2026-10-15T11:00:00Z") },
    { status: "failed", createdAt: at("2026-10-15T10:00:00Z") },
    { status: "completed", createdAt: at("2026-10-15T09:00:00Z") },
    { status: "failed", createdAt: at("2026-10-15T08:00:00Z") },
  ];
  assert.deepEqual(runFacts(rows, true), {
    working: true,
    lastRunAt: "2026-10-15T11:59:00.000Z",
    lastRunStatus: "failed",
    lastCompletedAt: "2026-10-15T09:00:00.000Z",
    failedRuns: 2,
  });
  assert.equal(
    runFacts(rows.slice(1, 3), false).failedRuns,
    2,
    "no completed run: every finished one failed",
  );
  assert.equal(runFacts(rows.slice(1, 3), false).lastCompletedAt, null);
  assert.deepEqual(runFacts([], false), NO_RUNS);
});
