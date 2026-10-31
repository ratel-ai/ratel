import assert from "node:assert/strict";
import { test } from "node:test";
import { TURN_IDLE_CLOSE_MS } from "@/lib/ledger/constants";
import { resolveWindowDays, signalWindow } from "@/lib/readings/trace-signals/signals/compute";
import { computeProjectTraceSignals } from "@/lib/readings/trace-signals/signals/compute-job";
import {
  type Db,
  jobDeps,
  PROJECT_ID,
  seedLedger,
  setupDb,
} from "@/lib/readings/trace-signals/signals/integration-support";
import {
  enqueueComputeJob,
  latestRunByProject,
  listProjectsWithRecentTurns,
  type RunTrigger,
  reapAllStaleSignalRuns,
  startSignalRun,
} from "@/lib/readings/trace-signals/signals/queries";
import { fresh, times } from "@/lib/readings/trace-signals/signals/test-fixtures";
import {
  dueSignalProjects,
  effectiveLastRunAt,
  MAX_SIGNAL_RUNS_PER_TICK,
  THIN_RUN_RETRY_MS,
} from "@/lib/readings/trace-signals/sweep";
import { sweepTraceSignals } from "@/lib/readings/trace-signals/sweep-service";

const HOUR = 60 * 60_000;
const NOW = new Date("2026-09-02T00:00:00Z");

test("the rotation: never-run first, live runs skipped, thin runs and first readings retried once turns close", () => {
  assert.equal(
    THIN_RUN_RETRY_MS,
    TURN_IDLE_CLOSE_MS + 5 * 60_000,
    "the idle-close window plus five minutes, not an hour",
  );
  const ago = (ms: number) => new Date(NOW.getTime() - ms);
  const latest = new Map([
    [
      "daily-old",
      { at: ago(25 * HOUR), status: "completed", turnsScanned: 500, trigger: "scheduled" },
    ],
    [
      "daily-fresh",
      {
        at: ago(THIN_RUN_RETRY_MS + 60_000),
        status: "completed",
        turnsScanned: 500,
        trigger: "scheduled",
      },
    ],
    [
      "thin",
      {
        at: ago(THIN_RUN_RETRY_MS + 60_000),
        status: "completed",
        turnsScanned: 12,
        trigger: "scheduled",
      },
    ],
    [
      "thin-fresh",
      {
        at: ago(THIN_RUN_RETRY_MS - 60_000),
        status: "completed",
        turnsScanned: 12,
        trigger: "scheduled",
      },
    ],
    // A first reading over the first 96 closed turns of a burst: read again once the rest has closed.
    [
      "first",
      {
        at: ago(THIN_RUN_RETRY_MS + 60_000),
        status: "completed",
        turnsScanned: 96,
        trigger: "first_build",
      },
    ],
    [
      "first-fresh",
      {
        at: ago(THIN_RUN_RETRY_MS - 60_000),
        status: "completed",
        turnsScanned: 96,
        trigger: "first_build",
      },
    ],
    ["running", { at: ago(5 * 60_000), status: "running", turnsScanned: 0 }],
  ]);
  const due = dueSignalProjects(
    ["daily-old", "daily-fresh", "thin", "thin-fresh", "first", "first-fresh", "running", "never"],
    latest,
    NOW,
  );
  assert.deepEqual(due.sort(), ["daily-old", "first", "never", "thin"]);
  assert.equal(
    effectiveLastRunAt(latest, NOW).get("running")?.getTime(),
    NOW.getTime() - 5 * 60_000,
  );
  assert.equal(dueSignalProjects(["a", "b", "c"], new Map(), NOW, { cap: 2 }).length, 2);
});

test("a live run counts from when it started, so one a crash left behind ages out", () => {
  const started = new Date(NOW.getTime() - 30 * HOUR);
  const latest = new Map([
    ["wedged", { at: started, startedAt: started, status: "running", turnsScanned: 0 }],
    [
      "queued",
      {
        at: new Date(NOW.getTime() - 30 * HOUR),
        startedAt: null,
        status: "queued",
        turnsScanned: 0,
      },
    ],
  ]);
  assert.equal(effectiveLastRunAt(latest, NOW).get("wedged")?.getTime(), started.getTime());
  assert.deepEqual(dueSignalProjects(["wedged", "queued"], latest, NOW).sort(), [
    "queued",
    "wedged",
  ]);
});

test("the window shrinks after a budget overrun and grows back once runs are quick", () => {
  assert.equal(resolveWindowDays(null, 7), 30, "a 7-day limit reads the 30-day default");
  assert.equal(resolveWindowDays(null, 90), 90, "a 90-day limit reads 90");
  const failed = {
    status: "failed",
    error: "time_budget",
    windowDays: 30,
    startedAt: null,
    finishedAt: null,
  };
  assert.equal(resolveWindowDays(failed, 30), 15);
  assert.equal(resolveWindowDays({ ...failed, windowDays: 10 }, 30), 7, "never below a week");
  const quick = {
    status: "completed",
    error: null,
    windowDays: 15,
    startedAt: NOW,
    finishedAt: new Date(NOW.getTime() + 1_000),
    summary: { windowShrunk: true },
  };
  assert.equal(resolveWindowDays(quick, 30, 6 * 60_000), 30);
  const slow = { ...quick, finishedAt: new Date(NOW.getTime() + 5 * 60_000) };
  assert.equal(
    resolveWindowDays(slow, 30, 6 * 60_000),
    15,
    "a run that barely fit keeps its window",
  );
  assert.equal(
    resolveWindowDays({ ...failed, windowDays: 90 }, 7),
    30,
    "a halved window never exceeds the plan's",
  );
});

test("a plan upgrade reads the new window at once instead of climbing to it", () => {
  // A 30-day run on Free, then an upgrade to Pro: that run was never shrunk.
  const onFree = {
    status: "completed",
    error: null,
    windowDays: 30,
    startedAt: NOW,
    finishedAt: new Date(NOW.getTime() + 1_000),
    summary: { version: 1 },
  };
  assert.equal(resolveWindowDays(onFree, 90), 90, "not 60");
  assert.equal(
    resolveWindowDays({ ...onFree, summary: null }, 90),
    90,
    "runs stored before the marker read as unshrunk",
  );
  const slowOnFree = { ...onFree, finishedAt: new Date(NOW.getTime() + 5 * 60_000) };
  assert.equal(
    resolveWindowDays(slowOnFree, 90, 6 * 60_000),
    90,
    "a slow unshrunk run does not pin the old window",
  );
  // Only after an overrun does the window shrink, and only then does it climb.
  const overran = {
    status: "failed",
    error: "time_budget",
    windowDays: 90,
    startedAt: null,
    finishedAt: null,
  };
  assert.equal(resolveWindowDays(overran, 90), 45);
  assert.equal(
    resolveWindowDays(
      { ...onFree, windowDays: 45, summary: { windowShrunk: true } },
      90,
      6 * 60_000,
    ),
    90,
  );
  assert.equal(
    resolveWindowDays(
      { ...slowOnFree, windowDays: 45, summary: { windowShrunk: true } },
      90,
      6 * 60_000,
    ),
    45,
    "a shrunk window that barely fit stays",
  );
  const w = signalWindow(NOW, 30);
  assert.equal((w.end.getTime() - w.start.getTime()) / (24 * HOUR), 30);
  assert.equal((w.start.getTime() - w.scanStart.getTime()) / (24 * HOUR), 30);
});

function sweepDeps(db: Db, now: Date) {
  return {
    listCandidates: (since: Date) => listProjectsWithRecentTurns(since, db),
    latestRuns: () => latestRunByProject(db),
    enqueue: (p: string, trigger: RunTrigger) => enqueueComputeJob(p, trigger, db),
    reapStale: (before: Date, at: Date) => reapAllStaleSignalRuns(before, db, at),
    now: () => now,
  };
}

async function insertRun(db: Db, startedAt: Date): Promise<void> {
  const run = await startSignalRun(
    {
      projectId: PROJECT_ID,
      trigger: "scheduled",
      windowDays: 30,
      windowStart: startedAt,
      windowEnd: startedAt,
      ledgerThrough: null,
    },
    db,
    startedAt,
  );
  assert.ok(run);
}

test("the sweep reaps a run a crashed job left running, and the project is due again", async () => {
  const { client, db } = await setupDb();
  await seedLedger(
    client,
    db,
    times(60, () => fresh().search(["a"]).invoke("a")),
  );
  await insertRun(db, new Date(NOW.getTime() - 26 * HOUR));

  const result = await sweepTraceSignals(sweepDeps(db, NOW));

  const runs = await client.query<{ status: string; error: string | null }>(
    `select status, error from trace_signal_runs`,
  );
  assert.deepEqual(runs.rows, [{ status: "failed", error: "stale" }]);
  assert.equal(result.runsEnqueued, 1, "the project is back in the rotation");
});

test("a fresh running run still blocks the sweep and is not reaped", async () => {
  const { client, db } = await setupDb();
  await seedLedger(
    client,
    db,
    times(60, () => fresh().search(["a"]).invoke("a")),
  );
  await insertRun(db, new Date(NOW.getTime() - 5 * 60_000));

  const result = await sweepTraceSignals(sweepDeps(db, NOW));

  const runs = await client.query<{ status: string }>(`select status from trace_signal_runs`);
  assert.deepEqual(runs.rows, [{ status: "running" }]);
  assert.equal(result.runsEnqueued, 0);
});

test("reaping is bounded and leaves finished runs alone", async () => {
  const { client, db } = await setupDb();
  await insertRun(db, new Date(NOW.getTime() - 26 * HOUR));
  await client.exec(`update trace_signal_runs set status = 'completed'`);
  await insertRun(db, new Date(NOW.getTime() - 20 * 60_000));

  assert.equal(
    await reapAllStaleSignalRuns(new Date(NOW.getTime() - 15 * 60_000), db, NOW, 0),
    0,
    "limit 0 reaps nothing",
  );
  assert.equal(await reapAllStaleSignalRuns(new Date(NOW.getTime() - 15 * 60_000), db, NOW), 1);
  const runs = await client.query<{ status: string }>(
    `select status from trace_signal_runs order by created_at`,
  );
  assert.deepEqual(
    runs.rows.map((r) => r.status),
    ["completed", "failed"],
  );
});

test("the sweep enqueues due projects once, and not again after a full run", async () => {
  const { client, db } = await setupDb();
  await seedLedger(
    client,
    db,
    times(60, () => fresh().search(["a"]).invoke("a")),
  );

  const first = await sweepTraceSignals(sweepDeps(db, NOW));
  assert.deepEqual(first, { projectsScanned: 1, runsEnqueued: 1, skipped: false });
  const again = await sweepTraceSignals(sweepDeps(db, NOW));
  assert.equal(again.runsEnqueued, 0, "the queued job coalesces");

  await client.exec(`delete from jobs`);
  await computeProjectTraceSignals(PROJECT_ID, { trigger: "scheduled" }, jobDeps(db, NOW));
  assert.equal((await sweepTraceSignals(sweepDeps(db, NOW))).runsEnqueued, 0, "ran today");
  const tomorrow = new Date(NOW.getTime() + 25 * HOUR);
  assert.equal((await sweepTraceSignals(sweepDeps(db, tomorrow))).runsEnqueued, 1);
  assert.ok(MAX_SIGNAL_RUNS_PER_TICK >= 1);
});
