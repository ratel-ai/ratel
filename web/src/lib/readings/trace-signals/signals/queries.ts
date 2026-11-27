import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import { jobs } from "@/lib/jobs/schema";
import { traceTurns } from "@/lib/ledger/schema";
import { getDb } from "@/lib/platform/db/client";
import { projects } from "@/lib/platform/projects/schema";
import {
  type NewTraceSignalRow,
  type TraceSignalRow,
  type TraceSignalRunRow,
  traceSignalRuns,
  traceSignals,
} from "@/lib/readings/trace-signals/schema";
import type { RunSummary } from "@/lib/readings/trace-signals/signals/analyze";
import { type DetectedSignal, signalKey } from "@/lib/readings/trace-signals/signals/types";
import type { SignalKind, TurnSourceMix } from "@/lib/readings/trace-signals/view";

/**
 * The database side of signal runs: the run lifecycle, the one-transaction
 * persist (upsert, mark missed, finish), the coalesced job enqueue, and the
 * reads the page and the sweep need. Every function takes an injectable `db`.
 */

export type SignalsQueryDb = ReturnType<typeof getDb>;

/** data_fixed: enough fixed data (turn ids, tool calls, users' messages) arrived after a reading that lacked it. */
/** `full_reading`: the full-window run that follows an early reading (RC-224). */
export const RUN_TRIGGERS = [
  "scheduled",
  "manual",
  "first_build",
  "data_fixed",
  "full_reading",
] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];
export const COMPUTE_JOB_KIND = "compute_trace_signals";

export function isRunTrigger(value: unknown): value is RunTrigger {
  return typeof value === "string" && (RUN_TRIGGERS as readonly string[]).includes(value);
}

/** Consecutive runs that measure a kind without detecting a signal before it resolves. */
export const MISSES_TO_RESOLVE = 2;

/**
 * The detectors' evidence-guard release, stamped on every stored signal's
 * metrics. A signal stored by an older release that the current one no longer
 * finds resolves at its first miss rather than its second: the guards say it
 * was not true, so it should not linger a day (false `asked_again`, repeat,
 * slow-tool and sequence cards).
 */
export const GUARDS_VERSION = 1;
const UPSERT_CHUNK = 100;
const LIVE_STATUSES = ["queued", "running"] as const;
const OPEN_STATUSES = ["open", "acknowledged"] as const;

// --- jobs ---------------------------------------------------------------------

/**
 * Enqueue a `compute_trace_signals` job, coalesced by the partial unique index
 * `jobs_compute_trace_signals_queued_idx` (one queued per project): returns
 * null when one is already waiting.
 */
export async function enqueueComputeJob(
  projectId: string,
  trigger: RunTrigger,
  db: Pick<SignalsQueryDb, "insert"> = getDb(),
): Promise<{ id: string } | null> {
  const rows = await db
    .insert(jobs)
    .values({ projectId, kind: COMPUTE_JOB_KIND, status: "queued", payload: { trigger } })
    .onConflictDoNothing()
    .returning({ id: jobs.id });
  return rows[0] ?? null;
}

// --- runs ---------------------------------------------------------------------

export interface StartRunInput {
  projectId: string;
  trigger: RunTrigger;
  windowDays: number;
  windowStart: Date;
  windowEnd: Date;
  ledgerThrough: Date | null;
}

/** Insert a running run, or null when the project already has a live one. */
export async function startSignalRun(
  input: StartRunInput,
  db: Pick<SignalsQueryDb, "insert"> = getDb(),
  now: Date = new Date(),
): Promise<TraceSignalRunRow | null> {
  const [row] = await db
    .insert(traceSignalRuns)
    .values({ ...input, status: "running", startedAt: now, createdAt: now })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

/** A live run older than this belongs to a job the stale-job reaper already gave up on. */
export const STALE_RUN_MS = 15 * 60_000;
/** Stale runs one sweep tick fails at most (there is at most one live run per project). */
export const STALE_RUN_REAP_LIMIT = 200;

/**
 * Fail live runs of any project that started before `before`, at most `limit`
 * per call. The sweep runs this every tick: a run a crashed job left
 * `running` would otherwise hold its project out of the rotation until
 * something else enqueued a job for it. Rides the one-live-run-per-project
 * partial index.
 */
export async function reapAllStaleSignalRuns(
  before: Date,
  db: Pick<SignalsQueryDb, "update" | "select"> = getDb(),
  now: Date = new Date(),
  limit: number = STALE_RUN_REAP_LIMIT,
): Promise<number> {
  const stale = db
    .select({ id: traceSignalRuns.id })
    .from(traceSignalRuns)
    .where(
      and(
        inArray(traceSignalRuns.status, [...LIVE_STATUSES]),
        lt(sql`coalesce(${traceSignalRuns.startedAt}, ${traceSignalRuns.createdAt})`, before),
      ),
    )
    .limit(limit);
  const reaped = await db
    .update(traceSignalRuns)
    .set({ status: "failed", error: "stale", finishedAt: now })
    .where(
      and(inArray(traceSignalRuns.id, stale), inArray(traceSignalRuns.status, [...LIVE_STATUSES])),
    )
    .returning({ id: traceSignalRuns.id });
  return reaped.length;
}

/** Fail live runs that started before `before`: a crashed job must not block the project forever. */
export async function reapStaleSignalRuns(
  projectId: string,
  before: Date,
  db: Pick<SignalsQueryDb, "update"> = getDb(),
  now: Date = new Date(),
): Promise<number> {
  const reaped = await db
    .update(traceSignalRuns)
    .set({ status: "failed", error: "stale", finishedAt: now })
    .where(
      and(
        eq(traceSignalRuns.projectId, projectId),
        inArray(traceSignalRuns.status, [...LIVE_STATUSES]),
        lt(sql`coalesce(${traceSignalRuns.startedAt}, ${traceSignalRuns.createdAt})`, before),
      ),
    )
    .returning({ id: traceSignalRuns.id });
  return reaped.length;
}

export async function failSignalRun(
  runId: string,
  error: string,
  db: Pick<SignalsQueryDb, "update"> = getDb(),
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(traceSignalRuns)
    .set({ status: "failed", error: error.slice(0, 2_000), finishedAt: now })
    .where(eq(traceSignalRuns.id, runId));
}

/**
 * Store a reading's Health score in its summary (`summary.healthScore`,
 * RC-225), written once its signals are persisted so it reads exactly the
 * open issues the page reads.
 */
export async function setRunHealthScore(
  runId: string,
  score: { version: number; value: number },
  db: Pick<SignalsQueryDb, "update"> = getDb(),
): Promise<void> {
  await db
    .update(traceSignalRuns)
    .set({
      summary: sql`coalesce(${traceSignalRuns.summary}, '{}'::jsonb) || ${JSON.stringify({ healthScore: score })}::jsonb`,
    })
    .where(eq(traceSignalRuns.id, runId));
}

/**
 * The stored Health scores of a project's completed readings before the
 * latest one, newest first: the page's change and trend (RC-225). Readings
 * stored before the score read as null.
 */
export async function listEarlierHealthScores(
  projectId: string,
  limit: number,
  db: Pick<SignalsQueryDb, "select"> = getDb(),
): Promise<unknown[]> {
  const rows = await db
    .select({ score: sql<unknown>`${traceSignalRuns.summary} -> 'healthScore'` })
    .from(traceSignalRuns)
    .where(and(eq(traceSignalRuns.projectId, projectId), eq(traceSignalRuns.status, "completed")))
    .orderBy(desc(traceSignalRuns.createdAt))
    .limit(limit + 1);
  return rows.slice(1).map((row) => row.score);
}

/** The project's latest run of any status, or of the given one. */
export async function latestSignalRun(
  projectId: string,
  db: Pick<SignalsQueryDb, "select"> = getDb(),
  status?: "completed",
): Promise<TraceSignalRunRow | null> {
  const [row] = await db
    .select()
    .from(traceSignalRuns)
    .where(
      and(
        eq(traceSignalRuns.projectId, projectId),
        status ? eq(traceSignalRuns.status, status) : undefined,
      ),
    )
    .orderBy(desc(traceSignalRuns.createdAt))
    .limit(1);
  return row ?? null;
}

export interface LatestRunFacts {
  at: Date;
  startedAt: Date | null;
  status: string;
  turnsScanned: number;
  trigger: string;
}

/** Each project's latest run: when, how it ended, how much it read, what started it. For the sweep. */
export async function latestRunByProject(
  db: Pick<SignalsQueryDb, "selectDistinctOn"> = getDb(),
): Promise<Map<string, LatestRunFacts>> {
  const rows = await db
    .selectDistinctOn([traceSignalRuns.projectId], {
      projectId: traceSignalRuns.projectId,
      at: traceSignalRuns.createdAt,
      startedAt: traceSignalRuns.startedAt,
      status: traceSignalRuns.status,
      turnsScanned: traceSignalRuns.turnsScanned,
      trigger: traceSignalRuns.trigger,
    })
    .from(traceSignalRuns)
    .orderBy(traceSignalRuns.projectId, desc(traceSignalRuns.createdAt));
  return new Map(
    rows.map((r) => [
      r.projectId,
      {
        at: r.at,
        startedAt: r.startedAt,
        status: r.status,
        turnsScanned: r.turnsScanned,
        trigger: r.trigger,
      },
    ]),
  );
}

/** A sweep candidate, when its latest closed turn ended, and how far its turns are built (receipt time). */
export interface SweepCandidate {
  projectId: string;
  lastTurnEndedAt: Date;
  /** `projects.trace_turns_built_through`: the receipt time of the newest event built into turns. */
  builtThrough: Date;
}

/**
 * Projects with closed turns ending at or after `since`, with when the latest
 * one ended: the sweep's candidates. The latest end is one backward step on
 * `trace_turns_closed_ended_idx` per project, so this costs what the plain
 * existence check it replaced did.
 */
export async function listSweepCandidates(
  since: Date,
  db: Pick<SignalsQueryDb, "select"> = getDb(),
): Promise<SweepCandidate[]> {
  // Spelled out: in a select list drizzle leaves columns unqualified, and a bare
  // "id" inside the subquery would be the turn's, not the project's.
  const lastEnd =
    sql<Date | null>`(select max(t.ended_at) from trace_turns t where t.project_id = ${projects}.id and t.status = 'closed')`.mapWith(
      traceTurns.endedAt,
    );
  const rows = await db
    .select({ id: projects.id, lastEnd, builtThrough: projects.traceTurnsBuiltThrough })
    .from(projects)
    .where(isNotNull(projects.traceTurnsBuiltThrough));
  return rows.flatMap((r) =>
    r.lastEnd !== null && r.builtThrough !== null && r.lastEnd.getTime() >= since.getTime()
      ? [{ projectId: r.id, lastTurnEndedAt: r.lastEnd, builtThrough: r.builtThrough }]
      : [],
  );
}

/** Projects with closed turns ending at or after `since`. */
export async function listProjectsWithRecentTurns(
  since: Date,
  db: Pick<SignalsQueryDb, "select"> = getDb(),
): Promise<string[]> {
  return (await listSweepCandidates(since, db)).map((c) => c.projectId);
}

// --- persist -------------------------------------------------------------------

export interface PersistRunInput {
  runId: string;
  projectId: string;
  signals: readonly DetectedSignal[];
  measured: ReadonlySet<SignalKind>;
  summary: RunSummary;
  turnsScanned: number;
  turnSourceMix: TurnSourceMix;
  corpusFingerprint: string | null;
  now: Date;
}

export interface PersistRunResult {
  open: number;
  opened: number;
  resolved: number;
}

function toRow(input: PersistRunInput, signal: DetectedSignal): NewTraceSignalRow {
  return {
    projectId: input.projectId,
    kind: signal.kind,
    subjectKind: signal.subjectKind,
    subjectKey: signal.subjectKey,
    subject: { ids: [...signal.subjectIds], entryKind: signal.entryKind, ...signal.subjectDetail },
    lane: signal.lane,
    tier: "deterministic",
    status: "open",
    severity: signal.severity,
    impact: signal.impact,
    n: signal.n,
    metrics: { ...signal.metrics, route: signal.route, guardsVersion: GUARDS_VERSION },
    evidence: { ...signal.evidence },
    firstSeenAt: input.now,
    lastSeenAt: input.now,
    lastRunId: input.runId,
    missedRuns: 0,
    updatedAt: input.now,
  };
}

const excluded = (column: string) => sql.raw(`excluded."${column}"`);

/**
 * Persist a finished run in one transaction: upsert every detected signal
 * (keeping `first_seen_at`, reopening a `resolved` one, never changing the
 * status of `acknowledged`, `fixed` or `muted`), count a miss against every
 * open or acknowledged signal of a measured kind that was not detected (the
 * second consecutive miss resolves it, the first for one stored before
 * {@link GUARDS_VERSION}), then finish the run with its counts.
 */
export async function persistSignalRun(
  input: PersistRunInput,
  db: Pick<SignalsQueryDb, "transaction"> = getDb(),
): Promise<PersistRunResult> {
  return db.transaction(async (tx) => {
    const existing = await tx
      .select({
        kind: traceSignals.kind,
        subjectKey: traceSignals.subjectKey,
        status: traceSignals.status,
      })
      .from(traceSignals)
      .where(eq(traceSignals.projectId, input.projectId));
    const statusByKey = new Map(
      existing.map((row) => [
        signalKey(row as Pick<DetectedSignal, "kind" | "subjectKey">),
        row.status,
      ]),
    );
    const opened = input.signals.filter((s) => {
      const status = statusByKey.get(signalKey(s));
      return status === undefined || status === "resolved";
    }).length;

    for (let i = 0; i < input.signals.length; i += UPSERT_CHUNK) {
      const chunk = input.signals.slice(i, i + UPSERT_CHUNK).map((s) => toRow(input, s));
      await tx
        .insert(traceSignals)
        .values(chunk)
        .onConflictDoUpdate({
          target: [traceSignals.projectId, traceSignals.kind, traceSignals.subjectKey],
          set: {
            subjectKind: excluded("subject_kind"),
            subject: excluded("subject"),
            lane: excluded("lane"),
            severity: excluded("severity"),
            impact: excluded("impact"),
            n: excluded("n"),
            metrics: excluded("metrics"),
            evidence: excluded("evidence"),
            lastSeenAt: excluded("last_seen_at"),
            lastRunId: excluded("last_run_id"),
            missedRuns: sql`0`,
            status: sql`case when ${traceSignals.status} = 'resolved' then 'open' else ${traceSignals.status} end`,
            resolvedAt: sql`case when ${traceSignals.status} = 'resolved' then null else ${traceSignals.resolvedAt} end`,
            updatedAt: excluded("updated_at"),
          },
        });
    }

    let resolved = 0;
    if (input.measured.size > 0) {
      const missed = sql`${traceSignals.missedRuns} + 1`;
      const stale = sql`coalesce((${traceSignals.metrics} ->> 'guardsVersion')::int, 0) < ${GUARDS_VERSION}`;
      const resolves = sql`(${missed} >= ${MISSES_TO_RESOLVE} or ${stale})`;
      const rows = await tx
        .update(traceSignals)
        .set({
          missedRuns: missed,
          status: sql`case when ${resolves} then 'resolved' else ${traceSignals.status} end`,
          resolvedAt: sql`case when ${resolves} then ${input.now.toISOString()}::timestamptz else ${traceSignals.resolvedAt} end`,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(traceSignals.projectId, input.projectId),
            inArray(traceSignals.status, [...OPEN_STATUSES]),
            inArray(traceSignals.kind, [...input.measured]),
            or(isNull(traceSignals.lastRunId), ne(traceSignals.lastRunId, input.runId)),
          ),
        )
        .returning({ status: traceSignals.status });
      resolved = rows.filter((r) => r.status === "resolved").length;
    }

    const [open] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(traceSignals)
      .where(
        and(
          eq(traceSignals.projectId, input.projectId),
          inArray(traceSignals.status, [...OPEN_STATUSES]),
        ),
      );

    const result = { open: open?.n ?? 0, opened, resolved };
    await tx
      .update(traceSignalRuns)
      .set({
        status: "completed",
        turnsScanned: input.turnsScanned,
        signalsOpen: result.open,
        signalsNew: result.opened,
        signalsResolved: result.resolved,
        turnSourceMix: { ...input.turnSourceMix },
        corpusFingerprint: input.corpusFingerprint,
        summary: input.summary as unknown as Record<string, unknown>,
        finishedAt: input.now,
      })
      .where(eq(traceSignalRuns.id, input.runId));
    return result;
  });
}

// --- page reads ------------------------------------------------------------------

/** Open and acknowledged signals, worst first. */
export async function listOpenSignals(
  projectId: string,
  db: Pick<SignalsQueryDb, "select"> = getDb(),
): Promise<TraceSignalRow[]> {
  return db
    .select()
    .from(traceSignals)
    .where(
      and(eq(traceSignals.projectId, projectId), inArray(traceSignals.status, [...OPEN_STATUSES])),
    )
    .orderBy(
      desc(traceSignals.severity),
      desc(traceSignals.impact),
      traceSignals.kind,
      traceSignals.subjectKey,
    );
}

/**
 * Hide one signal as slow by design, or show it again: `muted` from an open
 * status, `open` from `muted`. Only the dismissable kinds, only in the
 * project. Null when no such row is in a state to change.
 */
export async function setSignalDismissed(
  input: {
    projectId: string;
    signalId: string;
    kinds: readonly SignalKind[];
    dismissed: boolean;
    by: string;
    now?: Date;
  },
  db: Pick<SignalsQueryDb, "update"> = getDb(),
): Promise<{ id: string; kind: string } | null> {
  const now = input.now ?? new Date();
  const [row] = await db
    .update(traceSignals)
    .set(
      input.dismissed
        ? { status: "muted", acknowledgedAt: now, acknowledgedBy: input.by, updatedAt: now }
        : { status: "open", acknowledgedAt: null, acknowledgedBy: null, updatedAt: now },
    )
    .where(
      and(
        eq(traceSignals.id, input.signalId),
        eq(traceSignals.projectId, input.projectId),
        inArray(traceSignals.kind, [...input.kinds]),
        input.dismissed
          ? inArray(traceSignals.status, [...OPEN_STATUSES])
          : eq(traceSignals.status, "muted"),
      ),
    )
    .returning({ id: traceSignals.id, kind: traceSignals.kind });
  return row ?? null;
}

/** Signals of these kinds hidden by a person, for the "Show again" line. */
export async function listMutedSignals(
  projectId: string,
  kinds: readonly SignalKind[],
  db: Pick<SignalsQueryDb, "select"> = getDb(),
): Promise<Pick<TraceSignalRow, "id" | "kind" | "subjectKey">[]> {
  return db
    .select({ id: traceSignals.id, kind: traceSignals.kind, subjectKey: traceSignals.subjectKey })
    .from(traceSignals)
    .where(
      and(
        eq(traceSignals.projectId, projectId),
        eq(traceSignals.status, "muted"),
        inArray(traceSignals.kind, [...kinds]),
      ),
    )
    .orderBy(traceSignals.subjectKey, traceSignals.kind);
}

/** Runs created at or after `since`, newest first. For tests and diagnostics. */
export async function listSignalRunsSince(
  projectId: string,
  since: Date,
  db: Pick<SignalsQueryDb, "select"> = getDb(),
): Promise<TraceSignalRunRow[]> {
  return db
    .select()
    .from(traceSignalRuns)
    .where(and(eq(traceSignalRuns.projectId, projectId), gte(traceSignalRuns.createdAt, since)))
    .orderBy(desc(traceSignalRuns.createdAt));
}
