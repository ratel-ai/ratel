import { type SQL, sql } from "drizzle-orm";
import type { getDb } from "@/lib/platform/db/client";
import {
  type ChangedTrace,
  TRACE_END_USER_ID,
  TRACE_SESSION_ID,
} from "@/lib/synthesis/traces/summary-refresh";

/**
 * One-off backfill of `session_id` and `end_user_id` on `otel_spans` and
 * `otel_trace_summaries` (RTL-321, migration 0056) for rows stored before
 * ingest and the summary sweep wrote them.
 *
 * A stored span row does not keep most session and user keys (`span-rows.ts`
 * strips them), so the values come from `trace_events`, by trace id: the
 * earliest row of the trace with a session (not the trace id stand-in of the
 * derived rows) and the earliest with an end user. Every span of the trace
 * gets that value. Then the summary gets the sweep's value over its spans.
 *
 * - It walks the traces that have such a `trace_events` row, in
 *   `(project_id, trace_id)` keyset batches on `trace_events_project_trace_idx`.
 * - Dry run by default: it counts the rows it would fill and writes only with `apply`.
 * - Idempotent: it writes only a null column, so a re-run writes nothing and a
 *   value ingest or the sweep wrote is never replaced.
 * - `received_at` and `updated_at` are kept, so neither the summary sweep nor
 *   the scorers' sweep runs again for these traces.
 * - The end user is the raw `trace_events.end_user_id`, the value ingest stores.
 */

export type SessionUserBackfillDb = Pick<ReturnType<typeof getDb>, "execute">;

export interface SessionUserBackfillOptions {
  /** One project only. Absent, every project. */
  projectId?: string;
  /** Traces per batch. */
  batchSize?: number;
  /** Write the values. Absent or false, a dry run: walk and count, write nothing. */
  apply?: boolean;
  onBatch?: (progress: SessionUserBackfillResult) => void;
}

export interface SessionUserBackfillResult {
  /** Traces with a session or an end user in `trace_events`. */
  traces: number;
  /** Spans filled (or, in a dry run, that `apply` would fill). */
  spans: number;
  /** Summaries filled (or, in a dry run, that `apply` would fill). */
  summaries: number;
  batches: number;
}

export const SESSION_USER_BACKFILL_BATCH_SIZE = 500;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";
/** A `trace_events` row with a real session: the derived rows put the trace id there as a stand-in. */
const HAS_SESSION = sql.raw("te.session_id is not null and te.session_id <> te.trace_id");
const HAS_END_USER = sql.raw("te.end_user_id is not null");

export async function backfillSessionUserIds(
  db: SessionUserBackfillDb,
  {
    projectId,
    batchSize = SESSION_USER_BACKFILL_BATCH_SIZE,
    apply = false,
    onBatch,
  }: SessionUserBackfillOptions,
): Promise<SessionUserBackfillResult> {
  const progress: SessionUserBackfillResult = { traces: 0, spans: 0, summaries: 0, batches: 0 };
  let after: ChangedTrace = { projectId: NIL_UUID, traceId: "" };
  for (;;) {
    const batch = await nextBatch(db, projectId, after, batchSize);
    if (batch.length === 0) return progress;
    progress.spans += await fillSpans(db, batch, apply);
    progress.summaries += await fillSummaries(db, batch, apply);
    progress.traces += batch.length;
    progress.batches += 1;
    onBatch?.({ ...progress });
    after = batch[batch.length - 1]!;
  }
}

/**
 * The script's arguments as backfill options: `[--apply] [--project <id>]
 * [--batch-size <n>]`. Without `--apply` it is a dry run. `--dry-run` is
 * accepted and changes nothing; with `--apply` it is an error.
 */
export function sessionUserBackfillOptionsFromArgs(
  argv: readonly string[],
): SessionUserBackfillOptions & { apply: boolean; batchSize: number } {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    if (index < 0) return undefined;
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`${name} needs a value`);
    return next;
  };
  const apply = argv.includes("--apply");
  if (apply && argv.includes("--dry-run"))
    throw new Error("--apply and --dry-run cannot go together");
  const batchSize = Number(value("--batch-size") ?? SESSION_USER_BACKFILL_BATCH_SIZE);
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0)
    throw new Error("--batch-size needs a positive integer");
  const projectId = value("--project");
  return { apply, batchSize, ...(projectId ? { projectId } : {}) };
}

/** The next traces, in key order, that have a session or an end user in `trace_events`. */
async function nextBatch(
  db: SessionUserBackfillDb,
  projectId: string | undefined,
  after: ChangedTrace,
  limit: number,
): Promise<ChangedTrace[]> {
  const result = await db.execute(sql`
    select distinct te.project_id, te.trace_id from trace_events te
    where te.trace_id is not null
      and (te.project_id, te.trace_id) > (${after.projectId}::uuid, ${after.traceId}::text)
      and ((${HAS_SESSION}) or ${HAS_END_USER})
      ${projectId ? sql`and te.project_id = ${projectId}::uuid` : sql``}
    order by te.project_id, te.trace_id
    limit ${limit}`);
  return rowsOf<{ project_id: string; trace_id: string }>(result).map((row) => ({
    projectId: row.project_id,
    traceId: row.trace_id,
  }));
}

/** Fill the null columns of the batch's spans from `trace_events`; the count of spans. */
async function fillSpans(
  db: SessionUserBackfillDb,
  batch: readonly ChangedTrace[],
  apply: boolean,
): Promise<number> {
  const match = sql`
    where s.project_id = v.project_id and s.trace_id = v.trace_id
      and ((s.session_id is null and v.session_id is not null)
        or (s.end_user_id is null and v.end_user_id is not null))`;
  const result = await db.execute(
    apply
      ? sql`with ${traced(batch)}
          update otel_spans as s set
            session_id = coalesce(s.session_id, v.session_id),
            end_user_id = coalesce(s.end_user_id, v.end_user_id)
          from traced v
          ${match}
          returning 1`
      : sql`with ${traced(batch)} select 1 from otel_spans s, traced v ${match}`,
  );
  return rowsOf(result).length;
}

/**
 * Fill the null columns of the batch's summaries with the sweep's value over
 * their spans. In a dry run the spans are not filled yet, so the
 * `trace_events` value stands in for theirs.
 */
async function fillSummaries(
  db: SessionUserBackfillDb,
  batch: readonly ChangedTrace[],
  apply: boolean,
): Promise<number> {
  const values = sql`
    filled as (
      select v.project_id, v.trace_id,
        coalesce(${TRACE_SESSION_ID}, v.session_id) as session_id,
        coalesce(${TRACE_END_USER_ID}, v.end_user_id) as end_user_id
      from traced v
      join otel_spans s on s.project_id = v.project_id and s.trace_id = v.trace_id
      group by v.project_id, v.trace_id, v.session_id, v.end_user_id
    )`;
  const match = sql`
    where t.project_id = f.project_id and t.trace_id = f.trace_id
      and ((t.session_id is null and f.session_id is not null)
        or (t.end_user_id is null and f.end_user_id is not null))`;
  const result = await db.execute(
    apply
      ? sql`with ${traced(batch)}, ${values}
          update otel_trace_summaries as t set
            session_id = coalesce(t.session_id, f.session_id),
            end_user_id = coalesce(t.end_user_id, f.end_user_id)
          from filled f
          ${match}
          returning 1`
      : sql`with ${traced(batch)}, ${values}
          select 1 from otel_trace_summaries t, filled f ${match}`,
  );
  return rowsOf(result).length;
}

/** The CTE `traced`: each trace of the batch with its earliest session and end user in `trace_events`. */
function traced(batch: readonly ChangedTrace[]): SQL {
  const keys = sql.join(
    batch.map((trace) => sql`(${trace.projectId}::uuid, ${trace.traceId}::text)`),
    sql`, `,
  );
  const earliest = (column: SQL, where: SQL) => sql`(
    select ${column} from trace_events te
    where te.project_id = k.project_id and te.trace_id = k.trace_id and ${where}
    order by coalesce(te.occurred_at, te.received_at), te.id
    limit 1)`;
  return sql`traced as (
    select k.project_id, k.trace_id,
      ${earliest(sql.raw("te.session_id"), HAS_SESSION)} as session_id,
      ${earliest(sql.raw("te.end_user_id"), HAS_END_USER)} as end_user_id
    from (values ${keys}) as k(project_id, trace_id)
  )`;
}

function rowsOf<T = unknown>(result: unknown): T[] {
  return (result as { rows: T[] }).rows;
}
