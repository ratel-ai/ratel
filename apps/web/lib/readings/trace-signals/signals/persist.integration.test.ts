import assert from "node:assert/strict";
import { test } from "node:test";
import { DISMISSABLE_KINDS } from "@/lib/readings/trace-signals/dismiss";
import { analyzeTurns, type RunSummary } from "@/lib/readings/trace-signals/signals/analyze";
import {
  type Db,
  PROJECT_ID,
  setupDb,
} from "@/lib/readings/trace-signals/signals/integration-support";
import {
  listMutedSignals,
  listOpenSignals,
  persistSignalRun,
  setSignalDismissed,
  startSignalRun,
} from "@/lib/readings/trace-signals/signals/queries";
import { contextFor } from "@/lib/readings/trace-signals/signals/test-fixtures";
import type { DetectedSignal } from "@/lib/readings/trace-signals/signals/types";
import { loadPreviousWorkflows } from "@/lib/readings/trace-signals/signals/workflow-previous";
import type { SignalKind } from "@/lib/readings/trace-signals/view";
import { many, wfTurn } from "@/lib/readings/trace-signals/workflows/test-fixtures";

/** The signal lifecycle across runs: upsert, misses, resolve, reopen, and the statuses runs never touch. */

const SUMMARY: RunSummary = {
  version: 1,
  coveredFrom: "2026-08-01",
  daily: [],
  flow: { nodes: [], edges: [], totalTools: 0 },
};
const DAY_MS = 86_400_000;
const T0 = new Date("2026-09-01T00:00:00Z");

function signal(kind: SignalKind, subjectKey: string, severity = 0.5): DetectedSignal {
  return {
    kind,
    subjectKind: "tool",
    subjectKey,
    subjectIds: [subjectKey],
    entryKind: "tool",
    lane: "runtime",
    severity,
    impact: 10,
    n: 40,
    route: "rewrite_description",
    metrics: { k: 10, n: 40 },
    evidence: {
      turnIds: [],
      traceEventIds: [],
      totalTurns: 10,
      turnSourceMix: { declared: 0, inferred: 10, otlp: 0 },
    },
  };
}

async function run(
  db: Db,
  day: number,
  signals: DetectedSignal[],
  measured: SignalKind[] = ["magnet", "error_loop"],
  summary: RunSummary = SUMMARY,
) {
  const at = new Date(T0.getTime() + day * DAY_MS);
  const started = await startSignalRun(
    {
      projectId: PROJECT_ID,
      trigger: "scheduled",
      windowDays: 30,
      windowStart: at,
      windowEnd: at,
      ledgerThrough: null,
    },
    db,
    at,
  );
  assert.ok(started);
  return persistSignalRun(
    {
      runId: started.id,
      projectId: PROJECT_ID,
      signals,
      measured: new Set(measured),
      summary,
      turnsScanned: 100,
      turnSourceMix: { declared: 0, inferred: 100, otlp: 0 },
      corpusFingerprint: null,
      now: at,
    },
    db,
  );
}

async function states(client: Awaited<ReturnType<typeof setupDb>>["client"]) {
  const rows = await client.query<{
    subject_key: string;
    status: string;
    missed_runs: number;
    first_seen_at: string;
  }>(
    `select subject_key, status, missed_runs, first_seen_at::text from trace_signals order by subject_key`,
  );
  return Object.fromEntries(rows.rows.map((r) => [r.subject_key, r]));
}

test("upserts keep one row per signal, two misses resolve and a re-detection reopens it", async () => {
  const { client, db } = await setupDb();
  const first = await run(db, 0, [signal("magnet", "a"), signal("magnet", "b")]);
  assert.deepEqual(first, { open: 2, opened: 2, resolved: 0 });

  const second = await run(db, 1, [signal("magnet", "b", 0.7)]);
  assert.deepEqual(second, { open: 2, opened: 0, resolved: 0 });
  let s = await states(client);
  assert.equal(s.a?.status, "open");
  assert.equal(s.a?.missed_runs, 1);

  const third = await run(db, 2, [signal("magnet", "b")]);
  assert.equal(third.resolved, 1);
  s = await states(client);
  assert.equal(s.a?.status, "resolved");

  const fourth = await run(db, 3, [signal("magnet", "a"), signal("magnet", "b")]);
  assert.equal(fourth.opened, 1, "a reopened signal counts as newly opened");
  s = await states(client);
  assert.equal(s.a?.status, "open");
  assert.equal(s.a?.missed_runs, 0);
  assert.match(s.a?.first_seen_at ?? "", /^2026-09-01/, "first_seen_at survives the reopen");
  assert.equal(await client.query(`select 1 from trace_signals`).then((r) => r.rows.length), 2);
  const resolvedAt = await client.query<{ resolved_at: string | null }>(
    `select resolved_at from trace_signals where subject_key = 'a'`,
  );
  assert.equal(resolvedAt.rows[0]?.resolved_at, null);
});

test("acknowledged is preserved, fixed and muted are never touched, unmeasured kinds are not missed", async () => {
  const { client, db } = await setupDb();
  await run(db, 0, [
    signal("magnet", "ack"),
    signal("magnet", "fixed"),
    signal("magnet", "muted"),
    signal("error_loop", "err"),
  ]);
  await client.exec(`
    update trace_signals set status = 'acknowledged' where subject_key = 'ack';
    update trace_signals set status = 'fixed' where subject_key = 'fixed';
    update trace_signals set status = 'muted' where subject_key = 'muted';
  `);

  await run(db, 1, [signal("magnet", "ack"), signal("magnet", "fixed")], ["magnet"]);
  let s = await states(client);
  assert.equal(
    s.ack?.status,
    "acknowledged",
    "a detection does not flip acknowledged back to open",
  );
  assert.equal(s.fixed?.status, "fixed");
  assert.equal(s.muted?.status, "muted");
  assert.equal(s.muted?.missed_runs, 0, "muted signals are not counted as missed");
  assert.equal(s.err?.missed_runs, 0, "error_loop was not measured this run");

  await run(db, 2, [], ["magnet", "error_loop"]);
  await run(db, 3, [], ["magnet", "error_loop"]);
  s = await states(client);
  assert.equal(s.ack?.status, "resolved", "two misses resolve an acknowledged signal too");
  assert.equal(s.fixed?.status, "fixed");
  assert.equal(s.muted?.status, "muted");
  assert.equal(s.err?.status, "resolved");
});

test("a workflow signal stores its core and order in subject, and the next run keeps its id", async () => {
  const { client, db } = await setupDb();
  const fails = (i: number) => (i % 2 === 0 ? { tool: "d", outcome: "error" as const } : "d");
  const first = many(30, (i) => wfTurn(["a", "b", "c", fails(i)]));
  const one = analyzeTurns(
    first,
    contextFor(first, { previousWorkflows: await loadPreviousWorkflows(PROJECT_ID, db) }),
  );
  await run(db, 0, [...one.signals, signal("magnet", "m")], [...one.measured], one.summary);
  const rows = await client.query<{
    kind: string;
    subject_kind: string;
    subject_key: string;
    subject: Record<string, unknown>;
  }>(`select kind, subject_kind, subject_key, subject from trace_signals order by kind`);
  const failing = rows.rows.find((r) => r.kind === "workflow_failing");
  assert.ok(failing);
  assert.equal(failing.subject_kind, "workflow");
  assert.deepEqual(failing.subject, {
    ids: ["a", "b", "c", "d"],
    entryKind: "tool",
    coreTools: ["a", "b", "c", "d"],
    typicalOrder: ["a", "b", "c", "d"],
  });
  assert.deepEqual(
    rows.rows.find((r) => r.kind === "magnet")?.subject,
    { ids: ["m"], entryKind: "tool" },
    "other kinds are unchanged",
  );

  // Next run: the workflow grew a fifth tool; it keeps its id, so its signal is the same row.
  const second = many(30, (i) => wfTurn(["a", "b", "c", fails(i), "e"]));
  const previous = await loadPreviousWorkflows(PROJECT_ID, db);
  assert.deepEqual(previous, [{ id: failing.subject_key, coreTools: ["a", "b", "c", "d"] }]);
  const two = analyzeTurns(second, contextFor(second, { previousWorkflows: previous }));
  assert.equal(two.summary.workflows?.items[0]?.id, failing.subject_key);
  await run(db, 1, two.signals, [...two.measured], two.summary);
  const keys = await client.query<{ subject_key: string }>(
    `select subject_key from trace_signals where kind = 'workflow_failing'`,
  );
  assert.deepEqual(
    keys.rows.map((r) => r.subject_key),
    [failing.subject_key],
  );
});

test("a slow tool hidden as slow by design stays hidden through later runs, and shows again on request", async () => {
  const { db } = await setupDb();
  await run(
    db,
    0,
    [signal("latency_outlier", "render_video"), signal("error_loop", "glob")],
    ["latency_outlier", "error_loop"],
  );
  const [slow] = (await listOpenSignals(PROJECT_ID, db)).filter(
    (r) => r.kind === "latency_outlier",
  );
  assert.ok(slow);

  const hidden = await setSignalDismissed(
    {
      projectId: PROJECT_ID,
      signalId: slow.id,
      kinds: DISMISSABLE_KINDS,
      dismissed: true,
      by: "user_1",
    },
    db,
  );
  assert.deepEqual(hidden, { id: slow.id, kind: "latency_outlier" });
  await run(
    db,
    1,
    [signal("latency_outlier", "render_video", 0.9), signal("error_loop", "glob")],
    ["latency_outlier", "error_loop"],
  );
  assert.deepEqual(
    (await listOpenSignals(PROJECT_ID, db)).map((r) => r.kind),
    ["error_loop"],
    "a run never reopens it",
  );
  assert.deepEqual(
    (await listMutedSignals(PROJECT_ID, DISMISSABLE_KINDS, db)).map((r) => r.subjectKey),
    ["render_video"],
  );

  const [error] = await listOpenSignals(PROJECT_ID, db);
  const refused = await setSignalDismissed(
    {
      projectId: PROJECT_ID,
      signalId: error!.id,
      kinds: DISMISSABLE_KINDS,
      dismissed: true,
      by: "user_1",
    },
    db,
  );
  assert.equal(refused, null, "only the slow kinds can be hidden");
  const otherProject = await setSignalDismissed(
    {
      projectId: "00000000-0000-4000-8000-000000000999",
      signalId: slow.id,
      kinds: DISMISSABLE_KINDS,
      dismissed: false,
      by: "user_1",
    },
    db,
  );
  assert.equal(otherProject, null, "never across projects");

  const shown = await setSignalDismissed(
    {
      projectId: PROJECT_ID,
      signalId: slow.id,
      kinds: DISMISSABLE_KINDS,
      dismissed: false,
      by: "user_1",
    },
    db,
  );
  assert.ok(shown);
  assert.deepEqual((await listOpenSignals(PROJECT_ID, db)).map((r) => r.kind).sort(), [
    "error_loop",
    "latency_outlier",
  ]);
  assert.equal((await listMutedSignals(PROJECT_ID, DISMISSABLE_KINDS, db)).length, 0);
});
