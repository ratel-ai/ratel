import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { enqueueBuildTraceTurnsJob } from "@/lib/ledger/turns/queries";
import { PROJECT_ID, setupDb } from "@/lib/readings/trace-signals/signals/integration-support";
import { NO_RUNS } from "@/lib/views/health/ledger-facts";
import {
  countUnreadClosedTurns,
  loadLedgerFacts,
  loadRunFacts,
  readingInFlight,
} from "@/lib/views/health/ledger-facts-query";

const NOW = new Date("2026-10-15T12:00:00Z");
const MINUTE = 60_000;

let seq = 0;
async function turn(
  client: PGlite,
  row: {
    status: "open" | "closed";
    endedAt: string;
    receivedAt?: string;
    source?: string | null;
    updatedAt?: string;
  },
): Promise<void> {
  seq += 1;
  await client.query(
    `insert into trace_turns (project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at, source_id, updated_at)
     values ($1, $2, $3, 'otlp', 'otlp', $4, $5, $5, $6, $7, coalesce($8::timestamptz, now()))`,
    [
      PROJECT_ID,
      `s-${seq}`,
      `otlp:s-${seq}`,
      row.status,
      row.endedAt,
      row.receivedAt ?? row.endedAt,
      row.source ?? null,
      row.updatedAt ?? null,
    ],
  );
}

async function run(
  client: PGlite,
  row: { status: string; startedAt: string; error?: string },
): Promise<void> {
  await client.query(
    `insert into trace_signal_runs (project_id, trigger, status, error, window_days, window_start, window_end, started_at, created_at)
     values ($1, 'manual', $2, $4, 90, $3::timestamptz - interval '90 days', $3, $3, $3)`,
    [PROJECT_ID, row.status, row.startedAt, row.error ?? null],
  );
}

test("the ledger by window: open and closed, the idle ones, the imported ones, and the newest anywhere", async () => {
  const { client, db } = await setupDb();
  // Imported on Oct 12 and never closed: the reported demo.
  for (let i = 0; i < 3; i++) {
    await turn(client, {
      status: "open",
      endedAt: "2026-10-09T11:24:35Z",
      receivedAt: "2026-10-12T11:24:51Z",
      source: "langfuse-import",
    });
  }
  // A live run still going: open, and not idle.
  await turn(client, {
    status: "open",
    endedAt: "2026-10-15T11:55:00Z",
    receivedAt: "2026-10-15T11:59:00Z",
    source: "work-assistant",
  });
  await turn(client, { status: "closed", endedAt: "2026-09-14T20:48:39Z" });
  await turn(client, {
    status: "closed",
    endedAt: "2026-09-14T21:00:00Z",
    source: "langfuse-import",
  });
  // Older than every window.
  await turn(client, { status: "closed", endedAt: "2026-03-02T08:00:00Z" });

  const facts = await loadLedgerFacts(PROJECT_ID, { now: NOW, countImported: true }, db);

  assert.deepEqual(facts.windows[7], {
    turns: 4,
    closed: 0,
    idleOpen: 3,
    imported: 3,
    firstDay: "2026-10-09",
    lastDay: "2026-10-15",
  });
  assert.equal(facts.windows[30].turns, 4, "Sep 14 is 31 days back");
  assert.deepEqual(
    {
      turns: facts.windows[90].turns,
      closed: facts.windows[90].closed,
      imported: facts.windows[90].imported,
      firstDay: facts.windows[90].firstDay,
    },
    { turns: 6, closed: 2, imported: 4, firstDay: "2026-09-14" },
  );
  assert.equal(facts.newestDay, "2026-10-15");
  assert.equal(facts.working, false);
  assert.equal(facts.lastRunAt, null);

  const uncounted = await loadLedgerFacts(PROJECT_ID, { now: NOW, countImported: false }, db);
  assert.equal(
    uncounted.windows[90].imported,
    0,
    "imported turns are only counted for a project that imported",
  );
  assert.equal(uncounted.windows[90].turns, 6);
});

test("an empty ledger, and one whose only turns are older than every window", async () => {
  const { client, db } = await setupDb();
  const empty = await loadLedgerFacts(PROJECT_ID, { now: NOW }, db);
  assert.equal(empty.newestDay, null);
  assert.equal(empty.windows[90].turns, 0);

  await turn(client, { status: "closed", endedAt: "2026-03-02T08:00:00Z" });
  const old = await loadLedgerFacts(PROJECT_ID, { now: NOW }, db);
  assert.equal(old.windows[90].turns, 0);
  assert.equal(old.newestDay, "2026-03-02");
});

test("a reading on its way: a queued or freshly running signal run; not a build, not an abandoned run", async () => {
  const { client, db } = await setupDb();
  assert.equal(await readingInFlight(PROJECT_ID, NOW, db), false);

  // Ingest keeps a build queued on a busy project; a build is not a reading.
  await client.query(
    `insert into jobs (project_id, kind, status) values ($1, 'build_trace_turns', 'queued')`,
    [PROJECT_ID],
  );
  await client.query(
    `insert into jobs (project_id, kind, status) values ($1, 'label_workflows', 'queued')`,
    [PROJECT_ID],
  );
  await client.query(
    `insert into jobs (project_id, kind, status, started_at) values ($1, 'compute_trace_signals', 'running', $2)`,
    [PROJECT_ID, new Date(NOW.getTime() - 20 * MINUTE).toISOString()],
  );
  assert.equal(
    await readingInFlight(PROJECT_ID, NOW, db),
    false,
    "builds and labels are not readings; a run job 20 minutes in was abandoned",
  );

  await client.query(
    `insert into trace_signal_runs (project_id, trigger, status, window_days, window_start, window_end, started_at, created_at)
     values ($1, 'manual', 'running', 30, $2, $3, $3, $3)`,
    [
      PROJECT_ID,
      new Date(NOW.getTime() - 30 * 86_400_000).toISOString(),
      new Date(NOW.getTime() - MINUTE).toISOString(),
    ],
  );
  const facts = await loadLedgerFacts(PROJECT_ID, { now: NOW }, db);
  assert.equal(facts.working, true, "a run started a minute ago");
  assert.equal(facts.lastRunAt, new Date(NOW.getTime() - MINUTE).toISOString());

  await client.query(`update trace_signal_runs set status = 'completed'`);
  await client.query(
    `insert into jobs (project_id, kind, status) values ($1, 'compute_trace_signals', 'queued')`,
    [PROJECT_ID],
  );
  assert.equal(await readingInFlight(PROJECT_ID, NOW, db), true, "a queued run");
});

test("a build that carries an ask for a reading is one on its way, until it is done or abandoned", async () => {
  const { client, db } = await setupDb();
  await enqueueBuildTraceTurnsJob(PROJECT_ID, db);
  assert.equal(await readingInFlight(PROJECT_ID, NOW, db), false, "a plain build");

  await enqueueBuildTraceTurnsJob(PROJECT_ID, db, { reading: "manual" });
  assert.equal(
    await readingInFlight(PROJECT_ID, NOW, db),
    true,
    "the ask, merged into the queued build",
  );
  await client.query(`update jobs set status = 'running', started_at = $1`, [
    new Date(NOW.getTime() - MINUTE).toISOString(),
  ]);
  assert.equal(await readingInFlight(PROJECT_ID, NOW, db), true, "running");
  await client.query(`update jobs set started_at = $1`, [
    new Date(NOW.getTime() - 20 * MINUTE).toISOString(),
  ]);
  assert.equal(await readingInFlight(PROJECT_ID, NOW, db), false, "abandoned");
  await client.query(`update jobs set status = 'done', started_at = $1`, [
    new Date(NOW.getTime() - MINUTE).toISOString(),
  ]);
  assert.equal(
    await readingInFlight(PROJECT_ID, NOW, db),
    false,
    "done: the run it queued is what is on its way now",
  );
});

test("unread turns: closed turns in the window written or closed after the latest completed reading started", async () => {
  const { client, db } = await setupDb();
  const weekStart = new Date("2026-10-09T00:00:00Z");
  await turn(client, {
    status: "closed",
    endedAt: "2026-10-10T10:00:00Z",
    updatedAt: "2026-10-12T09:00:00Z",
  });
  await turn(client, {
    status: "closed",
    endedAt: "2026-10-11T10:00:00Z",
    updatedAt: "2026-10-12T12:00:00Z",
  });
  // Outside the window, and still open: neither counts.
  await turn(client, {
    status: "closed",
    endedAt: "2026-10-01T10:00:00Z",
    updatedAt: "2026-10-13T12:00:00Z",
  });
  await turn(client, {
    status: "open",
    endedAt: "2026-10-14T10:00:00Z",
    updatedAt: "2026-10-14T10:00:00Z",
  });

  assert.equal(
    await countUnreadClosedTurns(PROJECT_ID, weekStart, db),
    2,
    "before a first reading every closed turn in the window is unread",
  );

  await run(client, { status: "completed", startedAt: "2026-10-12T10:00:00Z" });
  assert.equal(
    await countUnreadClosedTurns(PROJECT_ID, weekStart, db),
    1,
    "the one closed after the reading started",
  );

  // A later run that failed read nothing: the reading is still the completed one.
  await run(client, { status: "failed", startedAt: "2026-10-12T13:00:00Z" });
  assert.equal(await countUnreadClosedTurns(PROJECT_ID, weekStart, db), 1);

  await run(client, { status: "completed", startedAt: "2026-10-12T13:30:00Z" });
  assert.equal(await countUnreadClosedTurns(PROJECT_ID, weekStart, db), 0);
  const facts = await loadLedgerFacts(PROJECT_ID, { now: NOW, windowDays: 7 }, db);
  assert.equal(facts.unreadClosed, 0);
  assert.equal(
    facts.lastRunAt,
    "2026-10-12T13:30:00.000Z",
    "the cooldown runs from the latest run of any status",
  );
});

test("run facts: how the latest runs ended, failures in a row, and whether one is on its way", async () => {
  const { client, db } = await setupDb();
  assert.deepEqual(await loadRunFacts(PROJECT_ID, NOW, db), NO_RUNS);

  await run(client, { status: "completed", startedAt: "2026-10-14T09:00:00Z" });
  await run(client, { status: "failed", startedAt: "2026-10-14T10:00:00Z", error: "time_budget" });
  await run(client, {
    status: "failed",
    startedAt: "2026-10-15T11:00:00Z",
    error: "connection reset",
  });
  assert.deepEqual(await loadRunFacts(PROJECT_ID, NOW, db), {
    working: false,
    lastRunAt: "2026-10-15T11:00:00.000Z",
    lastRunStatus: "failed",
    lastCompletedAt: "2026-10-14T09:00:00.000Z",
    failedRuns: 2,
  });

  // A run started a minute ago is on its way; it does not end the streak before it.
  const minuteAgo = new Date(NOW.getTime() - MINUTE).toISOString();
  await run(client, { status: "running", startedAt: minuteAgo });
  const live = await loadRunFacts(PROJECT_ID, NOW, db);
  assert.deepEqual(
    [live.working, live.lastRunAt, live.lastRunStatus, live.failedRuns],
    [true, minuteAgo, "failed", 2],
  );

  // Only the latest runs are read: past ten failures in a row the cooldown is at its cap anyway.
  for (let i = 0; i < 12; i += 1) {
    await run(client, {
      status: "failed",
      startedAt: new Date(NOW.getTime() - (2 + i) * MINUTE).toISOString(),
      error: "stale",
    });
  }
  const capped = await loadRunFacts(PROJECT_ID, NOW, db);
  assert.equal(capped.failedRuns, 9, "ten runs read, the live one among them");
  assert.equal(capped.lastCompletedAt, null, "the completed one is past the runs read");
});
