import { and, eq, exists, gt, inArray, notExists, or, sql } from "drizzle-orm";
import {
  foldableEventPredicate,
  foldableReceivedBefore,
} from "@/lib/ingest/trace-events/event-types";
import { RUNTIME_EVENT_RETENTION_DAYS } from "@/lib/ingest/trace-events/maintenance";
import { traceEvents } from "@/lib/ingest/trace-events/schema";
import { jobs } from "@/lib/jobs/schema";
import { getDb } from "@/lib/platform/db/client";
import { projects } from "@/lib/platform/projects/schema";
import { intentClusters, intentEngineState } from "@/lib/readings/intent-engine/schema";
import { type EngineDb, expireIdleClusters } from "@/lib/readings/intent-engine/store";

/**
 * Queueing the `cluster_intents` job: from ingest (paced, like the fold) and
 * from the cron drain's safety net. One queued job per project at most
 * (`jobs_cluster_intents_queued_idx`); the pacing read ranges on
 * `jobs_cluster_intents_finished_idx`.
 */

type JobsDb = Pick<ReturnType<typeof getDb>, "select" | "insert">;

export const CLUSTER_INTENTS_JOB = "cluster_intents" as const;

/**
 * Queue a run unless one is queued, or (with `minIntervalMs`) one finished that
 * recently: ingest paces itself and the cron picks up whatever the pause left.
 */
export async function enqueueClusterIntentsJob(
  projectId: string,
  db: JobsDb = getDb(),
  options: { minIntervalMs?: number } = {},
): Promise<{ id: string } | null> {
  if (options.minIntervalMs !== undefined && options.minIntervalMs > 0) {
    const [recent] = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.projectId, projectId),
          eq(jobs.kind, CLUSTER_INTENTS_JOB),
          inArray(jobs.status, ["done", "error"]),
          gt(jobs.finishedAt, new Date(Date.now() - options.minIntervalMs)),
        ),
      )
      .limit(1);
    if (recent) return null;
  }
  const rows = await db
    .insert(jobs)
    .values({ projectId, kind: CLUSTER_INTENTS_JOB, status: "queued", payload: null })
    .onConflictDoNothing()
    .returning({ id: jobs.id });
  return rows[0] ?? null;
}

/**
 * Projects with asks past the engine cursor and no queued or recently failed
 * run. Only projects the engine has met (a state row or a job of any status)
 * are candidates, so a project's first run comes from its ingest kick. Asks are
 * the fold's own rows (`foldableEventPredicate`, on the fold's partial index):
 * a user's message is read with the turn it belongs to, so it is never due on
 * its own.
 */
export async function listProjectsWithUnclusteredEvents(
  db: Pick<ReturnType<typeof getDb>, "select"> = getDb(),
  options: {
    retentionDays?: number;
    errorBackoffMs?: number;
    limit?: number;
    commitLagMs?: number;
  } = {},
): Promise<Array<{ id: string }>> {
  const windowStart = sql`now() - make_interval(days => ${options.retentionDays ?? RUNTIME_EVENT_RETENTION_DAYS})`;
  const backoffStart = new Date(Date.now() - (options.errorBackoffMs ?? 60 * 60 * 1000));
  const job = (status: string) =>
    and(
      eq(jobs.projectId, projects.id),
      eq(jobs.kind, CLUSTER_INTENTS_JOB),
      eq(jobs.status, status),
    );
  return db
    .select({ id: projects.id })
    .from(projects)
    .leftJoin(intentEngineState, eq(intentEngineState.projectId, projects.id))
    .where(
      and(
        or(
          sql`${intentEngineState.projectId} is not null`,
          exists(
            db
              .select({ one: sql`1` })
              .from(jobs)
              .where(and(eq(jobs.projectId, projects.id), eq(jobs.kind, CLUSTER_INTENTS_JOB))),
          ),
        ),
        exists(
          db
            .select({ one: sql`1` })
            .from(traceEvents)
            .where(
              and(
                eq(traceEvents.projectId, projects.id),
                foldableEventPredicate(traceEvents),
                sql`${traceEvents.receivedAt} > coalesce(${intentEngineState.clusteredThrough}, ${windowStart})`,
                foldableReceivedBefore(traceEvents, options.commitLagMs),
              ),
            ),
        ),
        notExists(db.select({ one: sql`1` }).from(jobs).where(job("queued"))),
        notExists(
          db
            .select({ one: sql`1` })
            .from(jobs)
            .where(and(job("error"), gt(jobs.finishedAt, backoffStart))),
        ),
      ),
    )
    .limit(options.limit ?? 200);
}

/** The cron drain's safety net: queue a run for every project with asks left. */
export async function enqueueDueIntentEngineRuns(
  overrides: Partial<{
    listProjectsWithUnclusteredEvents: typeof listProjectsWithUnclusteredEvents;
    enqueueClusterIntentsJob: typeof enqueueClusterIntentsJob;
  }> = {},
): Promise<{ enqueued: number }> {
  const deps = { listProjectsWithUnclusteredEvents, enqueueClusterIntentsJob, ...overrides };
  let enqueued = 0;
  for (const { id } of await deps.listProjectsWithUnclusteredEvents()) {
    if ((await deps.enqueueClusterIntentsJob(id)) !== null) enqueued += 1;
  }
  return { enqueued };
}

/** Clusters one cron tick expires at most, across projects. */
const EXPIRE_TICK_BATCH = 1_000;
/** Projects one cron tick visits at most. */
const EXPIRE_TICK_PROJECTS = 50;

/**
 * Retention for the engine: level-0 clusters whose last ask is older than
 * event retention go, with their assignments, a bounded batch per tick, so
 * member text forgets on the clock its events do. Each project is expired
 * under the engine's lock, skipped while a run holds it. The cron runs this
 * only with retention on (`DATA_RETENTION_ENABLED=1`).
 */
export async function expireIntentEngineClusters(
  options: { retentionDays?: number; batchSize?: number; now?: Date } = {},
  db: Pick<ReturnType<typeof getDb>, "select" | "transaction"> = getDb(),
): Promise<number> {
  const cutoffMs =
    (options.now ?? new Date()).getTime() -
    (options.retentionDays ?? RUNTIME_EVENT_RETENTION_DAYS) * 86_400_000;
  const budget = options.batchSize ?? EXPIRE_TICK_BATCH;
  const due = await db
    .select({ id: intentEngineState.projectId })
    .from(intentEngineState)
    .where(
      exists(
        db
          .select({ one: sql`1` })
          .from(intentClusters)
          .where(
            and(
              eq(intentClusters.projectId, intentEngineState.projectId),
              eq(intentClusters.level, 0),
              sql`${intentClusters.lastTs} < ${cutoffMs}`,
            ),
          ),
      ),
    )
    .limit(EXPIRE_TICK_PROJECTS);
  let expired = 0;
  for (const { id } of due) {
    if (expired >= budget) break;
    expired += await db.transaction(async (raw) => {
      const tx = raw as unknown as EngineDb;
      const lock = await tx.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_xact_lock(hashtext(${`intent-engine:${id}`}::text)) as locked`,
      );
      if (!lock.rows[0]?.locked) return 0;
      return expireIdleClusters(id, cutoffMs, budget - expired, tx);
    });
  }
  return expired;
}
