import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTraceEvents } from "@/lib/ingest/trace-events/parse";
import { insertTraceEvents } from "@/lib/ingest/trace-events/queries";
import { countClosedTurns } from "@/lib/ledger/closed-turns";
import { fixtureRows } from "@/lib/ledger/test-support";
import { buildProjectTraceTurns } from "@/lib/ledger/turns/build-job";
import type { ReloadReach } from "@/lib/ledger/turns/build-turn";
import {
  type BuildJobRequest,
  closeIdleTraceTurns,
  enqueueBuildTraceTurnsJob,
  getTraceTurnsCursor,
  listTurnEventHits,
  listTurnEventsPage,
  loadReloadableTurns,
  writeTurnPage,
} from "@/lib/ledger/turns/queries";
import { countFixesSince } from "@/lib/readings/trace-signals/signals/analysis-context";
import {
  computeProjectTraceSignals,
  enqueueFirstSignalRun,
  missedBacklog,
} from "@/lib/readings/trace-signals/signals/compute-job";
import { awaitedFixes } from "@/lib/readings/trace-signals/signals/data-fixes";
import {
  count,
  jobDeps,
  PROJECT_ID,
  seedLedger,
  setupDb,
  type Tracked,
} from "@/lib/readings/trace-signals/signals/integration-support";
import {
  enqueueComputeJob,
  latestSignalRun,
  listOpenSignals,
  persistSignalRun,
  type RunTrigger,
  startSignalRun,
} from "@/lib/readings/trace-signals/signals/queries";
import { fresh, times } from "@/lib/readings/trace-signals/signals/test-fixtures";
import type { DetectedSignal } from "@/lib/readings/trace-signals/signals/types";

const NOW = new Date("2026-09-02T00:00:00Z");

function problemFixtures() {
  return [
    ...times(130, () => fresh().search(["create_task", "search_tasks"]).invoke("search_tasks")),
    ...times(25, () =>
      fresh()
        .search(["find_task"])
        .invoke("find_task")
        .search(["assign_task"])
        .invoke("assign_task"),
    ),
  ];
}

test("a run computes signals over the stored ledger and persists them with the finished run", async () => {
  const { client, db } = await setupDb();
  await seedLedger(client, db, problemFixtures());
  const tracked: Tracked[] = [];

  const result = await computeProjectTraceSignals(
    PROJECT_ID,
    { trigger: "manual" },
    jobDeps(db, NOW, tracked),
  );

  assert.equal(result.outcome, "completed");
  assert.equal(result.turnsScanned, 155);
  assert.equal(result.windowDays, 90, "the default limits read 90 days");
  const run = await latestSignalRun(PROJECT_ID, db);
  assert.equal(run?.status, "completed");
  assert.equal(run?.trigger, "manual");
  assert.equal(run?.turnsScanned, 155);
  assert.ok(run?.ledgerThrough, "the run records the ledger cursor it read");
  const summary = run?.summary as { daily: unknown[]; flow: { nodes: unknown[] } };
  assert.ok(summary.daily.length > 0 && summary.flow.nodes.length > 0);
  const signals = await listOpenSignals(PROJECT_ID, db);
  const magnet = signals.find((s) => s.kind === "magnet");
  assert.equal(magnet?.subjectKey, "create_task");
  assert.ok(
    signals.some((s) => s.kind === "sequence_chain" && s.subjectKey === "find_task>assign_task"),
  );
  assert.equal(run?.signalsOpen, signals.length);
  assert.equal(run?.signalsNew, signals.length);
  const completed = tracked.find((t) => t.event === "trace_signal_run_completed");
  assert.equal(completed?.properties.object_action, "trace_signal_run_completed");
  assert.equal(completed?.properties.signals_open, signals.length);
});

test("the stored signals carry no query text", async () => {
  const { client, db } = await setupDb();
  await seedLedger(client, db, problemFixtures());
  await computeProjectTraceSignals(PROJECT_ID, { trigger: "manual" }, jobDeps(db, NOW));
  const dump = await client.query<{ row: string }>(
    `select row_to_json(s)::text as row from trace_signals s union all select row_to_json(r)::text from trace_signal_runs r`,
  );
  const text = dump.rows.map((r) => r.row).join("\n");
  assert.doesNotMatch(text, /query create_task/);
  assert.ok(!text.includes("search_tasks query"));
});

test("one live run per project: a second run is busy, a stale one is reaped", async () => {
  const { client, db } = await setupDb();
  await seedLedger(client, db, problemFixtures());
  const input = {
    projectId: PROJECT_ID,
    trigger: "manual" as const,
    windowDays: 30,
    windowStart: NOW,
    windowEnd: NOW,
    ledgerThrough: null,
  };
  assert.ok(await startSignalRun(input, db, NOW));
  assert.equal(await startSignalRun(input, db, NOW), null);

  const busy = await computeProjectTraceSignals(
    PROJECT_ID,
    { trigger: "scheduled" },
    jobDeps(db, NOW),
  );
  assert.equal(busy.outcome, "busy");

  const later = new Date(NOW.getTime() + 20 * 60_000);
  const after = await computeProjectTraceSignals(
    PROJECT_ID,
    { trigger: "scheduled" },
    jobDeps(db, later),
  );
  assert.equal(after.outcome, "completed");
  assert.equal(
    await count(client, `select count(*) as n from trace_signal_runs where error = 'stale'`),
    1,
  );
});

test("a run over its time budget fails with time_budget and the next run halves its window", async () => {
  const { client, db } = await setupDb();
  await seedLedger(client, db, problemFixtures());
  const tracked: Tracked[] = [];
  const over = await computeProjectTraceSignals(
    PROJECT_ID,
    { trigger: "scheduled" },
    jobDeps(db, NOW, tracked, { timeBudgetMs: -1 }),
  );
  assert.equal(over.outcome, "time_budget");
  const failed = await latestSignalRun(PROJECT_ID, db);
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.error, "time_budget");
  assert.equal(
    tracked.find((t) => t.event === "trace_signal_run_failed")?.properties.error,
    "time_budget",
  );

  const next = await computeProjectTraceSignals(
    PROJECT_ID,
    { trigger: "scheduled" },
    jobDeps(db, NOW),
  );
  assert.equal(next.windowDays, 45);
  const shrunk = await latestSignalRun(PROJECT_ID, db);
  assert.equal(
    (shrunk?.summary as { windowShrunk?: boolean } | null)?.windowShrunk,
    true,
    "the shrunk run says so",
  );

  // It finished well inside the budget, so the one after climbs back to the plan's window.
  const climbed = await computeProjectTraceSignals(
    PROJECT_ID,
    { trigger: "scheduled" },
    jobDeps(db, NOW),
  );
  assert.equal(climbed.windowDays, 90);
  const full = await latestSignalRun(PROJECT_ID, db);
  assert.equal(
    (full?.summary as { windowShrunk?: boolean } | null)?.windowShrunk,
    undefined,
    "a full window carries no marker",
  );
});

test("an open sequence signal survives two runs that skip the pair pass", async () => {
  const { client, db } = await setupDb();
  await seedLedger(
    client,
    db,
    times(40, () => fresh().search(["find_task"]).invoke("find_task")),
  );
  const signal = (kind: DetectedSignal["kind"], subjectKey: string): DetectedSignal => ({
    kind,
    subjectKind: kind === "sequence_chain" ? "tool_pair" : "tool",
    subjectKey,
    subjectIds: subjectKey.split(">"),
    entryKind: "tool",
    lane: "runtime",
    severity: 0.5,
    impact: 10,
    n: 20,
    route: "none",
    metrics: {},
    evidence: {
      turnIds: [],
      traceEventIds: [],
      totalTurns: 10,
      turnSourceMix: { declared: 0, inferred: 10, otlp: 0 },
    },
  });
  const seeded = await startSignalRun(
    {
      projectId: PROJECT_ID,
      trigger: "manual",
      windowDays: 90,
      windowStart: NOW,
      windowEnd: NOW,
      ledgerThrough: null,
    },
    db,
    NOW,
  );
  assert.ok(seeded);
  await persistSignalRun(
    {
      runId: seeded.id,
      projectId: PROJECT_ID,
      signals: [signal("sequence_chain", "find_task>assign_task"), signal("magnet", "ghost_tool")],
      measured: new Set(["sequence_chain", "magnet"]),
      summary: {
        version: 1,
        coveredFrom: "2026-08-01",
        daily: [],
        flow: { nodes: [], edges: [], totalTools: 0 },
      },
      turnsScanned: 40,
      turnSourceMix: { declared: 0, inferred: 40, otlp: 0 },
      corpusFingerprint: null,
      now: NOW,
    },
    db,
  );

  for (const day of [1, 2]) {
    const at = new Date(NOW.getTime() + day * 86_400_000);
    const result = await computeProjectTraceSignals(
      PROJECT_ID,
      { trigger: "scheduled" },
      jobDeps(db, at),
    );
    assert.equal(result.outcome, "completed");
  }

  const rows = await client.query<{ kind: string; status: string; missed_runs: number }>(
    `select kind, status, missed_runs from trace_signals order by kind`,
  );
  assert.deepEqual(rows.rows, [
    { kind: "magnet", status: "resolved", missed_runs: 2 },
    { kind: "sequence_chain", status: "open", missed_runs: 0 },
  ]);
});

test("the first reading waits for the closed-turn floor, and an idle close can be what reaches it", async () => {
  const { client, db } = await setupDb();
  seq = 0;
  const firstBuild =
    (floor: number, now: () => Date = () => new Date()) =>
    (p: string) =>
      enqueueFirstSignalRun(p, {
        latestRun: (id) => latestSignalRun(id, db),
        enqueue: (id, trigger) => enqueueComputeJob(id, trigger, db),
        countClosed: (id, from, to) => countClosedTurns(id, from, to, db),
        countFixes: (id, since, fixes) => countFixesSince(id, since, fixes, db),
        now,
        floor,
      });
  const queued = async () =>
    (
      await client.query<{ payload: { trigger: string } }>(
        `select payload from jobs where kind = 'compute_trace_signals' and status = 'queued'`,
      )
    ).rows.map((r) => r.payload.trigger);
  // A build as of `at`: its idle close sees every session quiet since before then.
  const buildAt = (at: Date, floor: number) =>
    buildProjectTraceTurns(PROJECT_ID, {
      ...buildDeps(
        db,
        firstBuild(floor, () => at),
      ),
      now: () => at,
    });

  // The first ingest batch: its turn is still open, so there is nothing to read yet.
  await ingest(db, [search("find the onboarding task", ["find_task"]), ...invocation("find_task")]);
  const first = await buildProjectTraceTurns(PROJECT_ID, buildDeps(db, firstBuild(1)));
  assert.equal(first.idleClosed, 0);
  assert.deepEqual(await queued(), [], "an open turn is not a first reading");

  // No new events, but the session went quiet: the build that only closes the
  // idle turn is the one that reaches the floor.
  const later = new Date(Date.now() + 2 * 60 * 60_000);
  const idle = await buildAt(later, 1);
  assert.equal(idle.pages, 0);
  assert.equal(idle.idleClosed, 1);
  assert.deepEqual(await queued(), ["first_build"]);
  assert.equal(
    await firstBuild(1, () => later)(PROJECT_ID),
    false,
    "coalesced while one is queued",
  );

  // A run on fewer turns than the floor is thin: the page reads it as
  // collecting, so the next closed turn that reaches the floor asks again.
  await client.exec(`delete from jobs where kind = 'compute_trace_signals'`);
  await computeProjectTraceSignals(PROJECT_ID, { trigger: "first_build" }, jobDeps(db, later));
  assert.equal((await latestSignalRun(PROJECT_ID, db))?.turnsScanned, 1);
  assert.equal(
    await firstBuild(2, () => later)(PROJECT_ID),
    false,
    "1 closed turn is under a floor of 2",
  );
  await ingest(db, [
    { ...search("assign it", ["assign_task"]), session_id: "sess-b" },
    ...invocation("assign_task").map((e) => ({ ...e, session_id: "sess-b" })),
  ]);
  await buildAt(new Date(later.getTime() + 60 * 60_000), 2);
  assert.deepEqual(
    await queued(),
    ["first_build"],
    "the second closed turn reaches the floor after a thin run",
  );

  // A run that read the floor is a reading: from then on the sweep owns the cadence.
  await client.exec(`delete from jobs where kind = 'compute_trace_signals'`);
  await computeProjectTraceSignals(
    PROJECT_ID,
    { trigger: "first_build" },
    jobDeps(db, new Date(later.getTime() + 60 * 60_000)),
  );
  assert.equal((await latestSignalRun(PROJECT_ID, db))?.turnsScanned, 2);
  assert.equal(
    await firstBuild(2, () => later)(PROJECT_ID),
    false,
    "a project with a reading is left to the sweep",
  );
});

test("a reading that lacked turn ids is read again once enough runs carry them, from those runs alone", async () => {
  const { client, db } = await setupDb();
  const run = (f: ReturnType<typeof fresh>) =>
    f.search(["find_pr", "link_pr"]).invoke("find_pr").invoke("link_pr").invoke("notify");
  await seedLedger(
    client,
    db,
    times(40, () => run(fresh())),
  );
  await computeProjectTraceSignals(PROJECT_ID, { trigger: "manual" }, jobDeps(db, NOW));
  assert.deepEqual(awaitedFixes((await latestSignalRun(PROJECT_ID, db))?.summary), [
    "turn_ids",
    "user_messages",
  ]);

  const fixedAt = new Date(NOW.getTime() + 60_000);
  await seedLedger(
    client,
    db,
    times(30, (i) =>
      run(fresh({ turnId: `turn-${i}`, start: new Date(fixedAt.getTime() + i * 60_000) })),
    ),
  );
  const fix = (now: Date) =>
    enqueueFirstSignalRun(PROJECT_ID, {
      latestRun: (id) => latestSignalRun(id, db),
      enqueue: (id, trigger) => enqueueComputeJob(id, trigger, db),
      countClosed: (id, from, to) => countClosedTurns(id, from, to, db),
      countFixes: (id, since, fixes) => countFixesSince(id, since, fixes, db),
      now: () => now,
      floor: 1,
    });
  assert.equal(
    await fix(new Date(NOW.getTime() + 10 * 60_000)),
    false,
    "too soon after the reading",
  );
  const later = new Date(NOW.getTime() + 3 * 60 * 60_000);
  assert.equal(await fix(later), true);
  const { rows } = await client.query<{ payload: { trigger: string } }>(
    `select payload from jobs where kind = 'compute_trace_signals'`,
  );
  assert.deepEqual(
    rows.map((r) => r.payload.trigger),
    ["data_fixed"],
  );

  await client.exec(`delete from jobs where kind = 'compute_trace_signals'`);
  await computeProjectTraceSignals(PROJECT_ID, { trigger: "data_fixed" }, jobDeps(db, later));
  const summary = (await latestSignalRun(PROJECT_ID, db))?.summary as {
    workflows?: { basis?: { basis: string; since: string; excludedRuns: number } };
  };
  assert.equal(summary.workflows?.basis?.basis, "exact");
  assert.equal(summary.workflows?.basis?.since, fixedAt.toISOString());
  assert.equal(summary.workflows?.basis?.excludedRuns, 40);
  assert.equal(
    await fix(new Date(later.getTime() + 60 * 60_000)),
    false,
    "a fix that already asked once waits longer",
  );
});

// --- a minimal ingest path, as the build job's own integration test uses ------

let seq = 0;
function envelope(body: Record<string, unknown>): Record<string, unknown> {
  seq += 1;
  return {
    v: 2,
    ts: Date.now() - 60 * 60_000 + seq * 1_000,
    session_id: "sess-a",
    source_id: "app",
    event_id: `evt-${seq}`,
    ...body,
  };
}
function search(query: string, hits: string[]) {
  return envelope({
    type: "search",
    query,
    origin: "agent",
    top_k: hits.length,
    hits: hits.map((tool_id, i) => ({ tool_id, score: 1 - i / 10 })),
  });
}
function invocation(tool: string) {
  return [
    envelope({ type: "invoke_start", tool_id: tool, invocation_id: `inv-${seq + 1}` }),
    envelope({ type: "invoke_end", tool_id: tool, invocation_id: `inv-${seq}`, took_ms: 40 }),
  ];
}
async function ingest(
  db: Awaited<ReturnType<typeof setupDb>>["db"],
  events: Record<string, unknown>[],
) {
  const { valid } = parseTraceEvents(events);
  await insertTraceEvents(
    PROJECT_ID,
    valid.map((e) => ({ ...e, ingestSource: "runtime" as const })),
    db,
  );
  await new Promise((r) => setTimeout(r, 5));
}
function buildDeps(
  db: Awaited<ReturnType<typeof setupDb>>["db"],
  onBacklogDrained: (p: string) => Promise<unknown>,
) {
  return {
    getCursor: (p: string) => getTraceTurnsCursor(p, db),
    listEvents: (p: string, since: Date | string, _db: unknown, limit?: number) =>
      listTurnEventsPage(p, since, db, limit),
    listHits: (ids: readonly string[]) => listTurnEventHits(ids, db),
    loadTurns: (p: string, s: readonly string[], k: readonly string[], reach: ReloadReach | null) =>
      loadReloadableTurns(p, s, k, reach, db),
    writePage: (input: Parameters<typeof writeTurnPage>[0]) => writeTurnPage(input, db),
    closeIdle: (p: string, before: Date, now: Date) => closeIdleTraceTurns(p, before, now, db),
    enqueueBuild: (p: string, request?: BuildJobRequest) =>
      enqueueBuildTraceTurnsJob(p, db, request),
    enqueueReading: (p: string, trigger: RunTrigger) => enqueueComputeJob(p, trigger, db),
    onBacklogDrained,
    observability: { trackSystemEvent: async () => undefined },
    salt: "test-salt",
  };
}

test("a run that starts while turn events wait to be built says how many, so the page can ask again", async () => {
  const { client, db } = await setupDb();
  await seedLedger(client, db, problemFixtures());
  const unbuiltAtStart = async () =>
    ((await latestSignalRun(PROJECT_ID, db))?.summary as { unbuiltAtStart?: number } | null)
      ?.unbuiltAtStart;
  const tracked: Tracked[] = [];

  // Everything built: a complete reading carries no marker.
  await computeProjectTraceSignals(PROJECT_ID, { trigger: "manual" }, jobDeps(db, NOW, tracked));
  assert.equal(await unbuiltAtStart(), undefined);

  // The few events a busy project always has in flight are not a missed backlog.
  seq = 0;
  await ingest(db, [search("find the task", ["find_task"]), ...invocation("find_task")]);
  await computeProjectTraceSignals(PROJECT_ID, { trigger: "manual" }, jobDeps(db, NOW, tracked));
  assert.equal(await unbuiltAtStart(), undefined);
  assert.equal(tracked.filter((t) => t.event === "trace_signal_run_completed").length, 2);

  // An import's worth of runs still waiting is: the run says how many it could not read.
  for (let i = 0; i < 10; i += 1) {
    await ingest(
      db,
      [search("assign it", ["assign_task"]), ...invocation("assign_task")].map((e) => ({
        ...e,
        session_id: `sess-${i}`,
      })),
    );
  }
  await computeProjectTraceSignals(PROJECT_ID, { trigger: "manual" }, jobDeps(db, NOW));
  assert.equal(await unbuiltAtStart(), 33);
});

test("a missed backlog is twenty events at least, and a tenth of the turns read", () => {
  assert.equal(missedBacklog(0, 0), false);
  assert.equal(missedBacklog(19, 0), false);
  assert.equal(missedBacklog(20, 0), true);
  assert.equal(missedBacklog(20, 155), true, "a tenth of 155 turns is 16");
  assert.equal(missedBacklog(29, 300), false);
  assert.equal(missedBacklog(30, 300), true);
});

test("fixture rows helper stays in step with the seeded ledger", async () => {
  const fixtures = [fresh().search(["a"]).invoke("a")];
  const { client, db } = await setupDb();
  await seedLedger(client, db, fixtures);
  assert.equal(
    await count(client, `select count(*) as n from trace_events`),
    fixtureRows(fixtures).rows.length,
  );
  assert.equal(
    await count(client, `select count(*) as n from trace_turns where status = 'closed'`),
    1,
  );
});
