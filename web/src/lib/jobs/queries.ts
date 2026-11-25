import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  lt,
  notInArray,
  type SQL,
  sql,
} from "drizzle-orm";
import { type Config, getConfig } from "@/config";
import { LONG_JOB_KINDS } from "@/lib/jobs/kinds";
import { jobTierSql, QUEUE_LAG_KINDS } from "@/lib/jobs/policy";
import { type Job, jobs } from "@/lib/jobs/schema";
import { getDb } from "@/lib/platform/db/client";

/** The job queue's queries (owned port of the upstream query hub). */

export type JobsDb = Pick<ReturnType<typeof getDb>, "select" | "insert">;

/**
 * A `running` job older than this with no result recorded is a zombie: the reaper fails it. It
 * matches the worker sweep's default time limit (`DEFAULT_DRAIN_TIMEOUT_MS`).
 */
export const STALE_JOB_MS = 10 * 60 * 1000;

/**
 * Every in-flight (`queued`/`running`) job for a project, newest first. Only fresh jobs: anything
 * created before the stale window is a zombie (or already reaped), and reporting it would claim
 * work is running when nothing is.
 */
export async function listInFlightJobs(
  projectId: string,
  db: JobsDb = getDb(),
): Promise<Array<{ jobId: string; kind: string; status: string }>> {
  const fresh = new Date(Date.now() - STALE_JOB_MS);
  const rows = await db
    .select({ id: jobs.id, kind: jobs.kind, status: jobs.status })
    .from(jobs)
    .where(
      and(
        eq(jobs.projectId, projectId),
        inArray(jobs.status, ["queued", "running"]),
        gt(jobs.createdAt, fresh),
      ),
    )
    .orderBy(desc(jobs.createdAt));
  return rows.map((r) => ({ jobId: r.id, kind: r.kind, status: r.status }));
}

/**
 * Fail jobs stuck in `running` since before `olderThan`: zombies left when a process died
 * mid-handler. The claim only ever takes `queued` rows, so a dead `running` row would otherwise
 * read as in flight forever. `spare` are jobs known to be alive however long they have run
 * (`Registration.liveJobs`): upstream spares an import whose own heartbeat is fresh, and reaps it
 * like any job once that stops. Returns how many were reaped.
 */
export async function reapStaleRunningJobs(
  olderThan: Date,
  db: ReturnType<typeof getDb> = getDb(),
  spare: readonly string[] = [],
): Promise<number> {
  const rows = await db
    .update(jobs)
    .set({ status: "error", error: "Timed out — no result was recorded.", finishedAt: new Date() })
    .where(
      and(
        eq(jobs.status, "running"),
        lt(jobs.startedAt, olderThan),
        spare.length > 0 ? notInArray(jobs.id, [...spare]) : undefined,
      ),
    )
    .returning({ id: jobs.id });
  return rows.length;
}

/** Enqueue a job for later processing. Returns the new job id to poll. */
export async function enqueueJob(
  input: { projectId: string; kind: string; payload?: unknown },
  db: JobsDb = getDb(),
): Promise<{ id: string }> {
  const [row] = await db
    .insert(jobs)
    .values({
      projectId: input.projectId,
      kind: input.kind,
      status: "queued",
      payload: input.payload ?? null,
    })
    .returning({ id: jobs.id });
  return { id: row.id };
}

/**
 * Enqueue unless a `queued` job of this kind already waits for the project: the coalescing the
 * partial unique indexes provide, returned as `null` instead of a conflict error.
 */
export async function enqueueJobOnce(
  input: { projectId: string; kind: string; payload?: unknown },
  db: JobsDb = getDb(),
): Promise<{ id: string } | null> {
  const rows = await db
    .insert(jobs)
    .values({
      projectId: input.projectId,
      kind: input.kind,
      status: "queued",
      payload: input.payload ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: jobs.id });
  return rows[0] ?? null;
}

/** The oldest queued-or-running job of a kind for a project, so an on-demand trigger does not stack a duplicate. */
export async function findInFlightJob(
  projectId: string,
  kind: string,
  db: JobsDb = getDb(),
): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.projectId, projectId),
        eq(jobs.kind, kind),
        inArray(jobs.status, ["queued", "running"]),
      ),
    )
    .orderBy(asc(jobs.createdAt))
    .limit(1);
  return row ?? null;
}

/** The database's clock, the one `jobs.created_at` is stamped with; the drain's claim bound. */
export async function readJobQueueClock(
  db: Pick<ReturnType<typeof getDb>, "execute"> = getDb(),
): Promise<Date> {
  const result = await db.execute(sql`select now() as now`);
  return new Date((result.rows[0] as { now: string | Date }).now);
}

/**
 * How long the oldest queued job of tier 0 or 1 has waited, in ms, on the database's clock; null
 * when none is queued. Tier 2 sweeps and imports wait on purpose (`QUEUE_LAG_KINDS`). A job a
 * per-project cap holds back still counts, because no column says why a job waits. An index on
 * `status` finds the queued rows, and no index holds the kind, so the kinds are a filter; the
 * read's cost depends on the queue, and no plan is guaranteed.
 */
export async function readOldestQueuedJobAgeMs(
  db: Pick<ReturnType<typeof getDb>, "execute"> = getDb(),
): Promise<number | null> {
  const result = await db.execute(oldestQueuedJobAgeQuery());
  const age = (result.rows[0] as { age_ms: string | number | null } | undefined)?.age_ms;
  return age === null || age === undefined ? null : Number(age);
}

/** The query of {@link readOldestQueuedJobAgeMs}. */
export function oldestQueuedJobAgeQuery(): SQL {
  const kinds = sql.join(
    QUEUE_LAG_KINDS.map((kind) => sql`${kind}`),
    sql`, `,
  );
  return sql`
    select floor(extract(epoch from now() - min(${jobs.createdAt})) * 1000) as age_ms
    from ${jobs}
    where ${jobs.status} = 'queued' and ${jobs.kind} = any(array[${kinds}]::text[])
  `;
}

/** Which job kinds a claim may take: only some, or all but some. */
export interface JobKindFilter {
  only?: readonly string[];
  except?: readonly string[];
}

/** Running jobs one project may have at once, across every drain. 0 turns the cap off. */
export function jobsRunningPerProject(config: Pick<Config, "jobs"> = getConfig()): number {
  return config.jobs.runningPerProject;
}

/**
 * Atomically claim the next `queued` job (optionally within a project), flipping it to
 * `running`. `FOR UPDATE SKIP LOCKED` means concurrent drains never claim the same row.
 * `createdBefore` leaves out rows queued after that instant, so a job a handler queues during a
 * drain waits for the next one instead of being claimed again by this one.
 *
 * Fair across projects: a project already running `runningPerProject` jobs is skipped (a soft
 * cap: two drains claiming at the same instant can each pass it), and the projects in
 * `avoidProjects` (the ones this drain just served) go last within a tier. Ordering, not a
 * filter: if only they have work, it still runs. Tiers come from `lib/jobs/policy.ts`.
 *
 * `kinds` keeps a claim to some kinds or away from them: the worker's import lane takes only
 * `run_import`, its analysis lane and the cron drain everything else (RC-40).
 */
export async function claimNextQueuedJob(
  projectId?: string,
  createdBefore?: Date,
  db: Pick<ReturnType<typeof getDb>, "update"> = getDb(),
  options: {
    avoidProjects?: readonly string[];
    runningPerProject?: number;
    kinds?: JobKindFilter;
  } = {},
): Promise<{
  id: string;
  projectId: string;
  kind: string;
  payload: unknown;
  createdAt: Date;
} | null> {
  const projectFilter = projectId ? sql`and q.project_id = ${projectId}` : sql``;
  const createdFilter = createdBefore
    ? sql`and q.created_at <= ${createdBefore.toISOString()}`
    : sql``;
  const kindFilter = options.kinds?.only
    ? sql`and q.kind = any(array[${sql.join(
        options.kinds.only.map((kind) => sql`${kind}`),
        sql`, `,
      )}]::text[])`
    : options.kinds?.except
      ? sql`and q.kind <> all(array[${sql.join(
          options.kinds.except.map((kind) => sql`${kind}`),
          sql`, `,
        )}]::text[])`
      : sql``;
  const cap = options.runningPerProject ?? jobsRunningPerProject();
  const longKinds = sql`(${sql.join(
    LONG_JOB_KINDS.map((kind) => sql`${kind}`),
    sql`, `,
  )})`;
  // Long jobs (imports, RC-40, and sandbox image builds) have their own lane in the worker and can take many minutes. A
  // running one does not count, or it would hold back the project's analysis (including the
  // build the import itself asks for), and the cap does not hold one back either: a project runs
  // one import at most.
  const capFilter =
    cap > 0
      ? sql`and (q.kind in ${longKinds} or (select count(*) from ${jobs} r where r.project_id = q.project_id and r.status = 'running' and r.kind not in ${longKinds}) < ${cap})`
      : sql``;
  const avoid = options.avoidProjects ?? [];
  const tier = jobTierSql(sql`q.kind`);
  const order =
    avoid.length > 0
      ? sql`order by ${tier}, (q.project_id = any(array[${sql.join(
          avoid.map((id) => sql`${id}`),
          sql`, `,
        )}]::uuid[])), q.created_at`
      : sql`order by ${tier}, q.created_at`;
  const claimed = await db
    .update(jobs)
    .set({ status: "running", startedAt: new Date() })
    .where(
      sql`${jobs.id} = (select q.id from ${jobs} q where q.status = 'queued' ${projectFilter} ${createdFilter} ${kindFilter} ${capFilter} ${order} for update of q skip locked limit 1)`,
    )
    .returning({
      id: jobs.id,
      projectId: jobs.projectId,
      kind: jobs.kind,
      payload: jobs.payload,
      createdAt: jobs.createdAt,
    });
  return claimed[0] ?? null;
}

export async function markJobDone(
  id: string,
  result: unknown,
  db: Pick<ReturnType<typeof getDb>, "update"> = getDb(),
): Promise<void> {
  await db
    .update(jobs)
    .set({ status: "done", result: result ?? null, finishedAt: new Date() })
    .where(eq(jobs.id, id));
}

export async function markJobError(id: string, error: string): Promise<void> {
  await getDb()
    .update(jobs)
    .set({ status: "error", error, finishedAt: new Date() })
    .where(eq(jobs.id, id));
}

/** One job scoped to the project that owns it, so an API-key caller can poll it. */
export async function getJobForProject(
  projectId: string,
  jobId: string,
  db: JobsDb = getDb(),
): Promise<Job | null> {
  const [row] = await db
    .select(getTableColumns(jobs))
    .from(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.projectId, projectId)))
    .limit(1);
  return row ?? null;
}
