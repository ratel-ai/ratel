import { sql } from "drizzle-orm";
import { REFILL_PIVOT_DIMS_JOB } from "@/lib/jobs/kinds";
import { getDb } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import { recomputeTraceSummaries } from "@/lib/synthesis/traces/summary-refresh";

/**
 * The pivot refill (RC-884): after a pivot is added or removed, refill `dims`
 * on the project's trace summaries in the retention window. It walks the
 * summaries in `trace_id` keyset batches on the primary key with the sweep's
 * own recompute, so it never moves the sweep cursor.
 *
 * - One per project: the jobs index `jobs_refill_pivot_dims_pending_idx` keeps
 *   at most one queued or running refill, so a second change never starts a
 *   parallel job. The running job compares the configuration at its end with
 *   the one it started from and walks again when they differ.
 * - Idempotent: a row is read only when written before the walk started, and
 *   a recompute gives it a fresh `updated_at`.
 * - Resumable: each batch saves its position in the job's payload. A job that
 *   died (reaped as `error`) is resumed by the next refill of the project with
 *   the same configuration.
 */

export interface RefillCheckpoint {
  /** The pivot configuration the walk fills. */
  fingerprint: string;
  /** Rows written at or after this are already filled. */
  before: string;
  /** The last trace the walk recomputed. */
  after: string;
}

export interface RefillPivotDimsResult {
  traces: number;
  batches: number;
  walks: number;
  resumed: boolean;
}

export interface RefillPivotDimsOptions {
  batchSize?: number;
  retentionMs?: number;
  now?: () => Date;
  /** After each batch, before the checkpoint is saved. A test throws here to stop a walk. */
  onBatch?: (progress: RefillPivotDimsResult) => void;
}

export type RefillDb = Pick<ReturnType<typeof getDb>, "execute">;

export const REFILL_BATCH_SIZE = 500;
/** Raw telemetry expires after 30 days; older summaries have no spans to read. */
export const REFILL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** A configuration that keeps changing during the walk is left to the next refill. */
const MAX_WALKS = 3;
const logger = getLogger("pivots/refill");

/** Queue the project's refill. Null when one is already queued or running. */
export async function enqueuePivotRefill(
  projectId: string,
  db: RefillDb = getDb(),
): Promise<{ id: string } | null> {
  const result = await db.execute(sql`
    insert into jobs (project_id, kind, status, payload)
    values (${projectId}::uuid, ${REFILL_PIVOT_DIMS_JOB}, 'queued', null)
    on conflict do nothing
    returning id`);
  const [row] = (result as unknown as { rows: Array<{ id: string }> }).rows;
  return row ? { id: row.id } : null;
}

/** Refill `dims` for one project, as the job `jobId`. */
export async function refillPivotDims(
  projectId: string,
  jobId: string,
  db: RefillDb = getDb(),
  options: RefillPivotDimsOptions = {},
): Promise<RefillPivotDimsResult> {
  const now = options.now ?? (() => new Date());
  const batchSize = options.batchSize ?? REFILL_BATCH_SIZE;
  const result: RefillPivotDimsResult = { traces: 0, batches: 0, walks: 0, resumed: false };
  let fingerprint = await pivotFingerprint(projectId, db);
  const resumed = await resumableCheckpoint(projectId, jobId, fingerprint, db);
  let checkpoint: RefillCheckpoint = resumed ?? {
    fingerprint,
    before: now().toISOString(),
    after: "",
  };
  result.resumed = resumed !== null;

  while (result.walks < MAX_WALKS) {
    result.walks += 1;
    const since = new Date(
      now().getTime() - (options.retentionMs ?? REFILL_RETENTION_MS),
    ).toISOString();
    for (;;) {
      const batch = await nextBatch(db, projectId, checkpoint, since, batchSize);
      if (batch.length === 0) break;
      await recomputeTraceSummaries(
        db,
        batch.map((traceId) => ({ projectId, traceId })),
      );
      result.traces += batch.length;
      result.batches += 1;
      options.onBatch?.({ ...result });
      checkpoint = { ...checkpoint, after: batch[batch.length - 1]! };
      await saveCheckpoint(jobId, checkpoint, db);
    }
    const current = await pivotFingerprint(projectId, db);
    if (current === fingerprint) break;
    fingerprint = current;
    checkpoint = { fingerprint, before: now().toISOString(), after: "" };
  }
  logger.info(
    {
      project_id: projectId,
      traces: result.traces,
      batches: result.batches,
      walks: result.walks,
      resumed: result.resumed,
    },
    "pivot dims refilled",
  );
  return result;
}

/** The pivot keys that decide `dims`: labels and order do not change a value. */
async function pivotFingerprint(projectId: string, db: RefillDb): Promise<string> {
  const result = await db.execute(sql`
    select coalesce(string_agg(key || ':' || coalesce(preset_id, ''), ',' order by key), '') as fingerprint
    from project_pivots where project_id = ${projectId}::uuid`);
  return (result as unknown as { rows: Array<{ fingerprint: string }> }).rows[0]?.fingerprint ?? "";
}

/**
 * Where to resume with the same configuration: this job's own position (a job
 * the reaper queued again), else the newest refill of the project that died
 * after the last one that finished.
 */
async function resumableCheckpoint(
  projectId: string,
  jobId: string,
  fingerprint: string,
  db: RefillDb,
): Promise<RefillCheckpoint | null> {
  const result = await db.execute(sql`
    select payload from jobs
    where project_id = ${projectId}::uuid and kind = ${REFILL_PIVOT_DIMS_JOB}
      and payload ->> 'fingerprint' = ${fingerprint}
      and (id = ${jobId}::uuid or (status = 'error' and created_at > coalesce((
        select max(created_at) from jobs
        where project_id = ${projectId}::uuid and kind = ${REFILL_PIVOT_DIMS_JOB} and status = 'done'
      ), '-infinity'::timestamptz)))
    order by (id = ${jobId}::uuid) desc, created_at desc limit 1`);
  const payload = (result as unknown as { rows: Array<{ payload: unknown }> }).rows[0]?.payload;
  return isCheckpoint(payload) ? payload : null;
}

async function saveCheckpoint(
  jobId: string,
  checkpoint: RefillCheckpoint,
  db: RefillDb,
): Promise<void> {
  await db.execute(
    sql`update jobs set payload = ${JSON.stringify(checkpoint)}::jsonb where id = ${jobId}::uuid`,
  );
}

async function nextBatch(
  db: RefillDb,
  projectId: string,
  checkpoint: RefillCheckpoint,
  since: string,
  limit: number,
): Promise<string[]> {
  const result = await db.execute(sql`
    select trace_id from otel_trace_summaries
    where project_id = ${projectId}::uuid and trace_id > ${checkpoint.after}::text
      and updated_at < ${checkpoint.before}::timestamptz
      and spans_max_received_at >= ${since}::timestamptz
    order by trace_id
    limit ${limit}`);
  return (result as unknown as { rows: Array<{ trace_id: string }> }).rows.map(
    (row) => row.trace_id,
  );
}

function isCheckpoint(value: unknown): value is RefillCheckpoint {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.fingerprint === "string" &&
    typeof entry.before === "string" &&
    typeof entry.after === "string"
  );
}
