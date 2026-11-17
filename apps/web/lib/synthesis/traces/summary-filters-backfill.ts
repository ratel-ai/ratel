import { sql } from "drizzle-orm";
import type { getDb } from "@/lib/platform/db/client";
import { type ChangedTrace, recomputeTraceSummaries } from "@/lib/synthesis/traces/summary-refresh";

/**
 * One-off backfill of the trace filter columns (RC-505, migration 0095).
 *
 * Migration 0095 adds `models`, `tools`, `service_name` and `environment` to
 * `otel_trace_summaries` at their defaults. The sweep fills them for every
 * trace it touches after the deploy; this fills the older rows. It walks the
 * summaries in `(project_id, trace_id)` keyset batches on the primary key and
 * recomputes each batch in full with the sweep's own recompute, so it never
 * moves the sweep cursor and never competes with new summaries for it.
 *
 * Only rows last written before `before` are read. A recomputed row gets a
 * fresh `updated_at`, so a re-run with the same `before` skips the rows a
 * previous run finished: the backfill is idempotent and resumable.
 */

export type SummaryFiltersBackfillDb = Pick<ReturnType<typeof getDb>, "execute">;

export interface SummaryFiltersBackfillOptions {
  /** Rows written at or after this already carry the columns (the 0095 deploy time). */
  before: Date;
  /** Traces per batch. */
  batchSize?: number;
  /** Walk and count the rows, write nothing. */
  dryRun?: boolean;
  onBatch?: (progress: SummaryFiltersBackfillResult) => void;
}

export interface SummaryFiltersBackfillResult {
  traces: number;
  batches: number;
}

export const SUMMARY_FILTERS_BACKFILL_BATCH_SIZE = 500;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export async function backfillTraceSummaryFilters(
  db: SummaryFiltersBackfillDb,
  {
    before,
    batchSize = SUMMARY_FILTERS_BACKFILL_BATCH_SIZE,
    dryRun = false,
    onBatch,
  }: SummaryFiltersBackfillOptions,
): Promise<SummaryFiltersBackfillResult> {
  const progress: SummaryFiltersBackfillResult = { traces: 0, batches: 0 };
  let after: ChangedTrace = { projectId: NIL_UUID, traceId: "" };
  for (;;) {
    const batch = await nextBatch(db, before, after, batchSize);
    if (batch.length === 0) return progress;
    if (!dryRun) await recomputeTraceSummaries(db, batch);
    progress.traces += batch.length;
    progress.batches += 1;
    onBatch?.({ ...progress });
    after = batch[batch.length - 1]!;
  }
}

async function nextBatch(
  db: SummaryFiltersBackfillDb,
  before: Date,
  after: ChangedTrace,
  limit: number,
): Promise<ChangedTrace[]> {
  const result = await db.execute(sql`
    select project_id, trace_id from otel_trace_summaries
    where (project_id, trace_id) > (${after.projectId}::uuid, ${after.traceId}::text)
      and updated_at < ${before.toISOString()}::timestamptz
    order by project_id, trace_id
    limit ${limit}`);
  const rows = (result as unknown as { rows: Array<{ project_id: string; trace_id: string }> })
    .rows;
  return rows.map((row) => ({ projectId: row.project_id, traceId: row.trace_id }));
}
