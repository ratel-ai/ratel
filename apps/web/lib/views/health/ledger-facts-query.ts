import { and, desc, eq, gt, gte, inArray, like, or, sql } from "drizzle-orm";
import { STALE_JOB_MS } from "@/lib/jobs/queries";
import { jobs } from "@/lib/jobs/schema";
import { IMPORTED_SOURCE_SUFFIX, TURN_IDLE_CLOSE_MS } from "@/lib/ledger/constants";
import { traceTurns } from "@/lib/ledger/schema";
import { getDb } from "@/lib/platform/db/client";
import { traceSignalRuns } from "@/lib/readings/trace-signals/schema";
import { COMPUTE_JOB_KIND, STALE_RUN_MS } from "@/lib/readings/trace-signals/signals/queries";
import type { WindowDays } from "@/lib/readings/trace-signals/view";
import {
  LEDGER_HORIZON_DAYS,
  type LedgerFacts,
  ledgerFacts,
  ledgerWindowStart,
  mergeDayCounts,
  type RunFacts,
  runFacts,
} from "@/lib/views/health/ledger-facts";

/**
 * The ledger reads behind `LedgerFacts`, for a page without a reading for
 * its window: closed turns per day over the longest window (the
 * `(project_id, ended_at)` index of closed turns answers it), open turns per
 * day (few, on their own index), the newest closed turn anywhere, imported
 * turns per day when the project has imported, whether a signal run is on its
 * way, and, for the selected window, the closed turns the latest reading has
 * not read.
 */

export type LedgerFactsDb = Pick<ReturnType<typeof getDb>, "select">;

/** A turn's end as a UTC day; the same text in select and group by, so Postgres groups on it. */
const endedDay = sql<string>`to_char(${traceTurns.endedAt} at time zone 'UTC', 'YYYY-MM-DD')`;

/**
 * Whether a reading is on its way: a signal run queued (as a job or a run), or
 * running and not abandoned, or a turn build that carries an ask for one (it
 * enqueues the run once it has caught up: `BuildJobRequest`). A plain build is
 * not one: ingest keeps a build queued on a busy project.
 */
export async function readingInFlight(
  projectId: string,
  now: Date,
  db: LedgerFactsDb = getDb(),
): Promise<boolean> {
  const [job] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.projectId, projectId),
        or(
          eq(jobs.kind, COMPUTE_JOB_KIND),
          and(eq(jobs.kind, "build_trace_turns"), sql`(${jobs.payload} ->> 'reading') is not null`),
        ),
        or(
          eq(jobs.status, "queued"),
          and(
            eq(jobs.status, "running"),
            gt(jobs.startedAt, new Date(now.getTime() - STALE_JOB_MS)),
          ),
        ),
      ),
    )
    .limit(1);
  if (job) return true;
  const [run] = await db
    .select({ id: traceSignalRuns.id })
    .from(traceSignalRuns)
    .where(
      and(
        eq(traceSignalRuns.projectId, projectId),
        inArray(traceSignalRuns.status, ["queued", "running"]),
        gt(
          sql`coalesce(${traceSignalRuns.startedAt}, ${traceSignalRuns.createdAt})`,
          new Date(now.getTime() - STALE_RUN_MS),
        ),
      ),
    )
    .limit(1);
  return run !== undefined;
}

/**
 * Closed turns ending in `[from, ...)` written or closed after the latest
 * completed run started (all of them before a first one): what the reading
 * has not read. Visits that window's closed turns only.
 */
export async function countUnreadClosedTurns(
  projectId: string,
  from: Date,
  db: LedgerFactsDb = getDb(),
): Promise<number> {
  const readingStarted = db
    .select({ at: sql`coalesce(${traceSignalRuns.startedAt}, ${traceSignalRuns.createdAt})` })
    .from(traceSignalRuns)
    .where(and(eq(traceSignalRuns.projectId, projectId), eq(traceSignalRuns.status, "completed")))
    .orderBy(desc(traceSignalRuns.createdAt))
    .limit(1);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(traceTurns)
    .where(
      and(
        eq(traceTurns.projectId, projectId),
        eq(traceTurns.status, "closed"),
        gte(traceTurns.endedAt, from),
        sql`${traceTurns.updatedAt} > coalesce((${readingStarted}), '-infinity'::timestamptz)`,
      ),
    );
  return row?.n ?? 0;
}

/** Runs read for a streak of failures; past this many the cooldown is at its cap anyway. */
const RUNS_READ = 10;

/**
 * The project's latest runs (their status, not their summaries)
 * and whether one is on its way: what the page times its requests by. On the
 * `(project_id, created_at)` index.
 */
export async function loadRunFacts(
  projectId: string,
  now: Date,
  db: LedgerFactsDb = getDb(),
): Promise<RunFacts> {
  const [rows, working] = await Promise.all([
    db
      .select({ status: traceSignalRuns.status, createdAt: traceSignalRuns.createdAt })
      .from(traceSignalRuns)
      .where(eq(traceSignalRuns.projectId, projectId))
      .orderBy(desc(traceSignalRuns.createdAt))
      .limit(RUNS_READ),
    readingInFlight(projectId, now, db),
  ]);
  return runFacts(rows, working);
}

export async function loadLedgerFacts(
  projectId: string,
  options: { now?: Date; countImported?: boolean; windowDays?: WindowDays } = {},
  db: LedgerFactsDb = getDb(),
): Promise<LedgerFacts> {
  const now = options.now ?? new Date();
  const horizon = ledgerWindowStart(now, LEDGER_HORIZON_DAYS);
  const idleBefore = new Date(now.getTime() - TURN_IDLE_CLOSE_MS);
  const project = eq(traceTurns.projectId, projectId);
  const [closed, open, imported, newest, runs, unreadClosed] = await Promise.all([
    db
      .select({ day: endedDay, n: sql<number>`count(*)::int` })
      .from(traceTurns)
      .where(and(project, eq(traceTurns.status, "closed"), gte(traceTurns.endedAt, horizon)))
      .groupBy(endedDay),
    db
      .select({
        day: endedDay,
        n: sql<number>`count(*)::int`,
        idle: sql<number>`(count(*) filter (where ${traceTurns.lastReceivedAt} < ${idleBefore}))::int`,
      })
      .from(traceTurns)
      .where(and(project, eq(traceTurns.status, "open")))
      .groupBy(endedDay),
    options.countImported
      ? db
          .select({ day: endedDay, n: sql<number>`count(*)::int` })
          .from(traceTurns)
          .where(
            and(
              project,
              // Owned: imported runs are known by their source suffix here, not a vendor list.
              like(traceTurns.sourceId, `%${IMPORTED_SOURCE_SUFFIX}`),
              or(
                and(eq(traceTurns.status, "closed"), gte(traceTurns.endedAt, horizon)),
                eq(traceTurns.status, "open"),
              ),
            ),
          )
          .groupBy(endedDay)
      : Promise.resolve([]),
    db
      .select({ at: sql<Date | string | null>`max(${traceTurns.endedAt})` })
      .from(traceTurns)
      .where(and(project, eq(traceTurns.status, "closed"))),
    loadRunFacts(projectId, now, db),
    options.windowDays
      ? countUnreadClosedTurns(projectId, ledgerWindowStart(now, options.windowDays), db)
      : Promise.resolve(0),
  ]);
  // The driver hands a timestamp back as a Date or as text, depending on the client.
  const newestAt = newest[0]?.at ? new Date(newest[0].at) : null;
  return ledgerFacts({
    rows: mergeDayCounts({ closed, open, imported }),
    newestClosedAt: newestAt && Number.isFinite(newestAt.getTime()) ? newestAt : null,
    runs,
    unreadClosed,
    now,
  });
}
