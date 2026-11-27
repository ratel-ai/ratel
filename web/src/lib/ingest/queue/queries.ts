import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import {
  type IngestBatchContext,
  type IngestBatchSignal,
  type IngestBatchStatus,
  ingestBatches,
} from "./schema";

/** The ingest queue's queries (RTL-314): enqueue, the fair claim, outcomes and housekeeping. */

export type IngestQueueDb = Pick<ReturnType<typeof getDb>, "insert" | "update" | "execute">;

/** How long a done batch's row stays for operators to read, and a failed one's. */
export const DONE_BATCH_RETENTION_MS = 60 * 60_000;
export const FAILED_BATCH_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** Rows one prune deletes at most, so a long backlog of old rows never makes one long statement. */
const PRUNE_LIMIT = 5_000;

export interface NewIngestBatch {
  projectId: string;
  signal: IngestBatchSignal;
  contentType: string;
  /** `gzip` or `deflate` when the body is still compressed as it arrived; null otherwise. */
  contentEncoding: string | null;
  body: Uint8Array;
  context: IngestBatchContext;
}

export interface ClaimedIngestBatch extends NewIngestBatch {
  id: string;
  /** This try's number: 1 on the first claim. */
  attempts: number;
  receivedAt: Date;
}

/** Store an accepted batch for a worker. Returns its id. */
export async function enqueueIngestBatch(
  input: NewIngestBatch,
  db: Pick<IngestQueueDb, "insert"> = getDb(),
): Promise<{ id: string }> {
  const [row] = await db
    .insert(ingestBatches)
    .values({
      projectId: input.projectId,
      signal: input.signal,
      contentType: input.contentType,
      contentEncoding: input.contentEncoding,
      body: input.body,
      bodyBytes: input.body.byteLength,
      context: input.context,
    })
    .returning({ id: ingestBatches.id });
  return { id: row.id };
}

export interface ClaimOptions {
  /** Batches one project may have running at once, across every process; 0 is no cap. */
  perProject: number;
  /**
   * Projects the claimer has served, the one served longest ago first: a project not in it goes
   * first, then these in this order, so a drainer takes turns round robin.
   */
  avoidProjects?: readonly string[];
}

/**
 * A batch `running` this long belongs to a process that stopped: the reaper queues it again, and
 * it no longer holds its project's slot.
 */
export const STALE_BATCH_MS = 5 * 60_000;

/**
 * Atomically claim the next queued batch whose backoff has passed, flipping it to `running` and
 * counting the try (the try's number is the claim's token: only it may record the outcome).
 * `FOR UPDATE SKIP LOCKED` keeps two claimers off the same row.
 *
 * Fair across projects, in two steps. First the project: one already running `perProject` batches
 * is left out (a soft cap: two claims at the same instant can each pass it; a batch running past
 * `STALE_BATCH_MS` does not count), then a project the claimer has not served goes first, then the
 * ones in `avoidProjects` from the one served longest ago (round robin), then the one waiting
 * longest. Then that project's oldest batch, through its `(project_id, received_at)` index, so a
 * claim does not sort the whole backlog. Should every batch of the chosen project be locked by
 * another claimer at that instant, the claim returns null; the next one moves on.
 */
export async function claimNextIngestBatch(
  db: Pick<IngestQueueDb, "execute"> = getDb(),
  options: ClaimOptions,
): Promise<ClaimedIngestBatch | null> {
  const capped =
    options.perProject > 0
      ? sql`select r.project_id from ${ingestBatches} r
          where r.status = 'running'
            and r.started_at > now() - make_interval(secs => ${STALE_BATCH_MS / 1000})
          group by r.project_id
          having count(*) >= ${options.perProject}`
      : sql`select null::uuid as project_id where false`;
  const avoid = options.avoidProjects ?? [];
  const turn =
    avoid.length > 0
      ? sql`array_position(array[${sql.join(
          avoid.map((id) => sql`${id}`),
          sql`, `,
        )}]::uuid[], c.project_id) nulls first,`
      : sql``;
  const result = await db.execute(sql`
    with capped as (${capped}),
    candidates as (
      select p.project_id,
        (select min(h.received_at) from ${ingestBatches} h
          where h.project_id = p.project_id and h.status = 'queued' and h.available_at <= now())
          as oldest
      from (
        select distinct w.project_id from ${ingestBatches} w
        where w.status = 'queued' and w.available_at <= now()
      ) p
      where p.project_id not in (select capped.project_id from capped where capped.project_id is not null)
    ),
    chosen as (
      select c.project_id from candidates c order by ${turn} c.oldest limit 1
    )
    update ${ingestBatches} b
    set status = 'running', started_at = now(), attempts = b.attempts + 1
    where b.id = (
      select q.id from ${ingestBatches} q
      where q.project_id = (select chosen.project_id from chosen)
        and q.status = 'queued' and q.available_at <= now()
      order by q.received_at
      for update of q skip locked
      limit 1
    )
    returning b.id, b.project_id, b.signal, b.content_type, b.content_encoding, b.body, b.context,
      b.attempts, b.received_at
  `);
  const row = result.rows[0] as unknown as RawClaimedRow | undefined;
  return row ? toClaimed(row) : null;
}

interface RawClaimedRow {
  id: string;
  project_id: string;
  signal: IngestBatchSignal;
  content_type: string;
  content_encoding: string | null;
  body: Uint8Array;
  context: IngestBatchContext | null;
  attempts: number;
  received_at: Date | string;
}

function toClaimed(row: RawClaimedRow): ClaimedIngestBatch {
  return {
    id: row.id,
    projectId: row.project_id,
    signal: row.signal,
    contentType: row.content_type,
    contentEncoding: row.content_encoding,
    body: row.body,
    context: row.context ?? {},
    attempts: Number(row.attempts),
    receivedAt: new Date(row.received_at),
  };
}

/**
 * Only the try that holds the claim records its outcome: the row is still `running` under that
 * try's number. A try the reaper took back (and maybe gave to another claimer) changes nothing.
 */
const ownedBy = (id: string, attempt: number) =>
  and(
    eq(ingestBatches.id, id),
    eq(ingestBatches.status, "running"),
    eq(ingestBatches.attempts, attempt),
  );

/** A persisted batch: done, with its outcome, and without its bytes. */
export async function markIngestBatchDone(
  id: string,
  attempt: number,
  result: unknown,
  db: Pick<IngestQueueDb, "update"> = getDb(),
): Promise<void> {
  await db
    .update(ingestBatches)
    .set({
      status: "done",
      result: result ?? null,
      error: null,
      body: new Uint8Array(0),
      finishedAt: new Date(),
    })
    .where(ownedBy(id, attempt));
}

/** A batch no retry can fix (it does not decode): failed at once, its bytes kept for an operator. */
export async function failIngestBatch(
  id: string,
  attempt: number,
  error: string,
  db: Pick<IngestQueueDb, "update"> = getDb(),
): Promise<void> {
  await db
    .update(ingestBatches)
    .set({ status: "failed", error, finishedAt: new Date() })
    .where(ownedBy(id, attempt));
}

/**
 * A try that failed for a reason that may pass (the database, a timeout): back in the queue after
 * `backoffMs`, or `failed` once it has had `maxAttempts` tries. Returns where it went, or `lost`
 * when this try no longer holds the claim.
 */
export async function retryIngestBatch(
  id: string,
  attempt: number,
  error: string,
  options: { maxAttempts: number; backoffMs: number },
  db: Pick<IngestQueueDb, "execute"> = getDb(),
): Promise<Extract<IngestBatchStatus, "queued" | "failed"> | "lost"> {
  const result = await db.execute(sql`
    update ${ingestBatches}
    set status = case when attempts >= ${options.maxAttempts} then 'failed' else 'queued' end,
      error = ${error},
      started_at = null,
      available_at = now() + make_interval(secs => ${options.backoffMs / 1000}),
      finished_at = case when attempts >= ${options.maxAttempts} then now() else null end
    where id = ${id} and status = 'running' and attempts = ${attempt}
    returning status
  `);
  return (result.rows[0] as { status: "queued" | "failed" } | undefined)?.status ?? "lost";
}

/**
 * Batches `running` for longer than `staleMs` on the database's clock (a process died mid-batch):
 * back in the queue, or `failed` once they have had `maxAttempts` tries. Persisting is
 * idempotent, so a batch that did finish before its process died adds nothing when it runs again,
 * and a slow try that is still alive can no longer record its outcome (`ownedBy`).
 */
export async function reapStaleIngestBatches(
  staleMs: number,
  maxAttempts: number,
  db: Pick<IngestQueueDb, "execute"> = getDb(),
): Promise<{ requeued: number; failed: number }> {
  const result = await db.execute(sql`
    update ${ingestBatches}
    set status = case when attempts >= ${maxAttempts} then 'failed' else 'queued' end,
      error = 'Timed out: the process persisting it stopped.',
      started_at = null,
      finished_at = case when attempts >= ${maxAttempts} then now() else null end
    where status = 'running' and started_at < now() - make_interval(secs => ${staleMs / 1000})
    returning status
  `);
  const rows = result.rows as Array<{ status: string }>;
  const failed = rows.filter((row) => row.status === "failed").length;
  return { requeued: rows.length - failed, failed };
}

/** Retention: done batches after an hour, failed ones after a week; a queued batch is never pruned. */
export async function pruneIngestBatches(
  db: Pick<IngestQueueDb, "execute"> = getDb(),
): Promise<number> {
  const result = await db.execute(sql`
    delete from ${ingestBatches}
    where id in (
      select id from ${ingestBatches}
      where (status = 'done' and finished_at < now() - make_interval(secs => ${DONE_BATCH_RETENTION_MS / 1000}))
        or (status = 'failed' and finished_at < now() - make_interval(secs => ${FAILED_BATCH_RETENTION_MS / 1000}))
      limit ${PRUNE_LIMIT}
    )
    returning id
  `);
  return result.rows.length;
}

export interface IngestQueueProjectStats {
  projectId: string;
  queued: number;
  running: number;
  /** How long the oldest queued batch has waited, on the database's clock; null when none waits. */
  oldestAgeMs: number | null;
  failedLastHour: number;
}

/** Per project with anything queued, running or failed in the last hour: the autoscaling and alert inputs. */
export async function readIngestQueueStats(
  db: Pick<IngestQueueDb, "execute"> = getDb(),
): Promise<IngestQueueProjectStats[]> {
  const result = await db.execute(sql`
    select project_id,
      count(*) filter (where status = 'queued') as queued,
      count(*) filter (where status = 'running') as running,
      count(*) filter (where status = 'failed') as failed,
      floor(extract(epoch from now() - min(received_at) filter (where status = 'queued')) * 1000)
        as oldest_age_ms
    from ${ingestBatches}
    where status in ('queued', 'running')
      or (status = 'failed' and finished_at > now() - interval '1 hour')
    group by project_id
    order by project_id
  `);
  return (
    result.rows as unknown as Array<{
      project_id: string;
      queued: string | number;
      running: string | number;
      failed: string | number;
      oldest_age_ms: string | number | null;
    }>
  ).map((row) => ({
    projectId: row.project_id,
    queued: Number(row.queued),
    running: Number(row.running),
    oldestAgeMs: row.oldest_age_ms === null ? null : Number(row.oldest_age_ms),
    failedLastHour: Number(row.failed),
  }));
}
