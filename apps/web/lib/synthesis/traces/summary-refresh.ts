import { and, asc, eq, lt, sql } from "drizzle-orm";
import { otelSpans } from "@/lib/ingest/otlp/schema";
import { getDb } from "@/lib/platform/db/client";
import { traceSummaryCursor } from "@/lib/synthesis/traces/schema";

/**
 * The sweep only ever works inside its own transaction, so the injectable
 * surface is just `transaction` — everything else runs on the handed-out `tx`.
 */
export type TraceSummaryRefreshDb = Pick<ReturnType<typeof getDb>, "transaction">;

type SweepTransaction = Parameters<Parameters<TraceSummaryRefreshDb["transaction"]>[0]>[0];

interface ChangedTrace {
  projectId: string;
  traceId: string;
}

interface SweepCursor {
  receivedAt: Date;
  spanRowId: string;
}

interface BatchOutcome {
  spansScanned: number;
  tracesRecomputed: number;
}

export interface RefreshTraceSummariesOptions {
  /** Spans folded in per transaction. */
  batchSize?: number;
  /** Wall-clock the whole sweep may spend before yielding to the next tick. */
  timeBudgetMs?: number;
  /** How far behind `now()` the cursor stays; see `TRACE_SUMMARY_VISIBILITY_LAG_MS`. */
  visibilityLagMs?: number;
  now?: () => number;
}

export interface TraceSummaryRefreshResult {
  spansScanned: number;
  tracesRecomputed: number;
  batches: number;
  /** The sweep reached the end of the visible span stream. */
  caughtUp: boolean;
  /** Another tick held the advisory lock, so this one deliberately did nothing. */
  lockContended: boolean;
}

/** Constant key of the single `trace_summary_cursor` row. */
export const TRACE_SUMMARY_CURSOR_ID = "otel_spans";
export const TRACE_SUMMARY_REFRESH_BATCH_SIZE = 5_000;
/** Leaves the 1-minute drain tick ample headroom under `maxDuration = 300`. */
export const TRACE_SUMMARY_REFRESH_TIME_BUDGET_MS = 25_000;
/**
 * Floor for how far behind the watermark stays; see `settledBefore` for the
 * exact bound this backstops. Costs the KPIs this much staleness, nothing else.
 */
export const TRACE_SUMMARY_VISIBILITY_LAG_MS = 5_000;
/** Bounds one recompute statement's VALUES list (mirrors the span insert chunk). */
const TRACE_SUMMARY_RECOMPUTE_CHUNK_SIZE = 500;
/** Arbitrary but stable; only this sweep takes it. */
const TRACE_SUMMARY_ADVISORY_LOCK_KEY = 823_100_023;
const EPOCH = new Date(0);
const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const MAX_INTERVAL_MS = 2_000_000_000;

/**
 * Fold newly-received spans into the `otel_trace_summaries` silver table.
 *
 * Runs off a `(received_at, id)` watermark over `otel_spans_received_at_idx`:
 * each batch collects the traces touched by the next span slice and recomputes
 * those traces **in full**, then advances the cursor in the same transaction.
 * Full recompute (rather than an additive upsert) is what makes the sweep
 * idempotent — a replayed or overlapping tick reproduces the same row instead of
 * double-counting into it — and self-healing after any gap.
 *
 * Because the cursor starts at the epoch, this same code path *is* the backfill:
 * early ticks drain retained history under the time budget, then it tails
 * ingest. There is no separate backfill mode and no activation cutover.
 *
 * Nothing here touches the OTLP ingest path, and the read path stays behind
 * `cloud-trace-rollups`, so a broken sweep can only make KPIs stale.
 */
export async function refreshTraceSummaries(
  options: RefreshTraceSummariesOptions = {},
  db: TraceSummaryRefreshDb = getDb(),
): Promise<TraceSummaryRefreshResult> {
  const batchSize = boundedCount(options.batchSize, TRACE_SUMMARY_REFRESH_BATCH_SIZE);
  const timeBudgetMs = boundedCount(options.timeBudgetMs, TRACE_SUMMARY_REFRESH_TIME_BUDGET_MS);
  const visibilityLagMs = boundedLagMs(options.visibilityLagMs);
  const now = options.now ?? Date.now;
  const startedAt = now();
  const result: TraceSummaryRefreshResult = {
    spansScanned: 0,
    tracesRecomputed: 0,
    batches: 0,
    caughtUp: false,
    lockContended: false,
  };

  while (now() - startedAt < timeBudgetMs) {
    const batch = await db.transaction((tx) => sweepOneBatch(tx, batchSize, visibilityLagMs));
    // An overlapping tick owns the stream; duplicating its work would be
    // harmless but wasteful, so stand down until the next minute.
    if (batch === null) {
      result.lockContended = true;
      return result;
    }
    if (batch.spansScanned === 0) {
      result.caughtUp = true;
      return result;
    }
    result.spansScanned += batch.spansScanned;
    result.tracesRecomputed += batch.tracesRecomputed;
    result.batches += 1;
  }

  return result;
}

/** One transaction: claim the lock, read a span slice, recompute, advance. */
async function sweepOneBatch(
  tx: SweepTransaction,
  batchSize: number,
  visibilityLagMs: number,
): Promise<BatchOutcome | null> {
  if (!(await tryAdvisoryLock(tx))) return null;

  const cursor = await readCursor(tx);
  const spans = await tx
    .select({
      id: otelSpans.id,
      projectId: otelSpans.projectId,
      traceId: otelSpans.traceId,
      receivedAt: otelSpans.receivedAt,
    })
    .from(otelSpans)
    .where(
      and(
        // Row-wise comparison so the walk stays on (received_at, id).
        sql`(${otelSpans.receivedAt}, ${otelSpans.id}) > (${cursor.receivedAt.toISOString()}::timestamptz, ${cursor.spanRowId}::uuid)`,
        lt(otelSpans.receivedAt, settledBefore(visibilityLagMs)),
      ),
    )
    .orderBy(asc(otelSpans.receivedAt), asc(otelSpans.id))
    .limit(batchSize);
  if (spans.length === 0) return { spansScanned: 0, tracesRecomputed: 0 };

  const changed = distinctTraces(spans);
  for (let offset = 0; offset < changed.length; offset += TRACE_SUMMARY_RECOMPUTE_CHUNK_SIZE) {
    await recomputeSummaries(
      tx,
      changed.slice(offset, offset + TRACE_SUMMARY_RECOMPUTE_CHUNK_SIZE),
    );
  }
  const last = spans[spans.length - 1]!;
  await advanceCursor(tx, { receivedAt: last.receivedAt, spanRowId: last.id });

  return { spansScanned: spans.length, tracesRecomputed: changed.length };
}

/**
 * Replace each changed trace's summary from scratch in a single statement: the
 * canonical whole-trace representative (riding
 * `otel_spans_project_trace_root_idx`) joined to that trace's own aggregates.
 */
async function recomputeSummaries(tx: SweepTransaction, traces: ChangedTrace[]): Promise<void> {
  const changed = sql.join(
    traces.map((trace) => sql`(${trace.projectId}::uuid, ${trace.traceId}::text)`),
    sql`, `,
  );
  await tx.execute(sql`
    with changed (project_id, trace_id) as (values ${changed}),
    representatives as (
      select distinct on (s.project_id, s.trace_id)
        s.project_id, s.trace_id, s.started_at, s.duration_ms
      from otel_spans s
      join changed c
        on c.project_id = s.project_id and c.trace_id = s.trace_id
      order by
        s.project_id,
        s.trace_id,
        (s.parent_span_id is null) desc,
        s.started_at,
        s.span_id
    ),
    aggregates as (
      select
        s.project_id,
        s.trace_id,
        bool_or(s.status_code = 2) as has_error,
        coalesce(sum(s.input_tokens), 0)::bigint as input_tokens,
        coalesce(sum(s.output_tokens), 0)::bigint as output_tokens,
        coalesce(sum(s.cost_usd), 0)::numeric(18, 6) as cost_usd,
        max(s.received_at) as spans_max_received_at
      from otel_spans s
      join changed c
        on c.project_id = s.project_id and c.trace_id = s.trace_id
      group by s.project_id, s.trace_id
    )
    insert into otel_trace_summaries (
      project_id, trace_id, started_at, duration_ms, has_error,
      input_tokens, output_tokens, cost_usd, spans_max_received_at, updated_at
    )
    select
      r.project_id,
      r.trace_id,
      r.started_at,
      r.duration_ms,
      a.has_error,
      a.input_tokens,
      a.output_tokens,
      a.cost_usd,
      a.spans_max_received_at,
      now()
    from representatives r
    join aggregates a
      on a.project_id = r.project_id and a.trace_id = r.trace_id
    on conflict (project_id, trace_id) do update set
      started_at = excluded.started_at,
      duration_ms = excluded.duration_ms,
      has_error = excluded.has_error,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cost_usd = excluded.cost_usd,
      spans_max_received_at = excluded.spans_max_received_at,
      updated_at = excluded.updated_at
  `);
}

/**
 * Transaction-scoped so it can never be leaked by a crash. Correctness does not
 * depend on it — the recompute is idempotent — it only stops two ticks from
 * redoing the same batch.
 */
async function tryAdvisoryLock(tx: SweepTransaction): Promise<boolean> {
  const result = await tx.execute(
    sql`select pg_try_advisory_xact_lock(${TRACE_SUMMARY_ADVISORY_LOCK_KEY}::bigint) as locked`,
  );
  const [row] = (result as unknown as { rows?: Array<{ locked?: unknown }> }).rows ?? [];
  return row?.locked === true;
}

/** The watermark, or the epoch when the sweep has never run (so it backfills). */
async function readCursor(tx: SweepTransaction): Promise<SweepCursor> {
  const [row] = await tx
    .select({
      receivedAt: traceSummaryCursor.receivedAt,
      spanRowId: traceSummaryCursor.spanRowId,
    })
    .from(traceSummaryCursor)
    .where(eq(traceSummaryCursor.id, TRACE_SUMMARY_CURSOR_ID));

  return row ?? { receivedAt: EPOCH, spanRowId: NIL_UUID };
}

async function advanceCursor(tx: SweepTransaction, cursor: SweepCursor): Promise<void> {
  await tx
    .insert(traceSummaryCursor)
    .values({ id: TRACE_SUMMARY_CURSOR_ID, ...cursor })
    .onConflictDoUpdate({
      target: traceSummaryCursor.id,
      set: { ...cursor, updatedAt: sql`now()` },
    });
}

function distinctTraces(spans: ReadonlyArray<ChangedTrace>): ChangedTrace[] {
  const byKey = new Map<string, ChangedTrace>();
  for (const { projectId, traceId } of spans) {
    const key = `${projectId}�${traceId}`;
    if (!byKey.has(key)) byKey.set(key, { projectId, traceId });
  }
  return [...byKey.values()];
}

/**
 * The newest receipt time this sweep may consume — the crux of never losing a
 * span.
 *
 * `received_at` defaults to `now()`, which Postgres evaluates at *transaction
 * start*, and `insertOtelSpans` wraps a whole export in one transaction. So a
 * slow export commits rows stamped with its `BEGIN`, which a watermark that had
 * meanwhile advanced past that instant would skip permanently — a fixed lag only
 * narrows that window to "exports slower than the lag", it does not close it.
 *
 * The oldest in-flight transaction's `xact_start` closes it exactly: nothing
 * still uncommitted anywhere can later produce a row older than that. Our own
 * transaction is in that set and its `xact_start` *is* `now()`, so the clamp
 * only ever tightens, never loosens.
 *
 * The lag stays as the floor for the one case the clamp can't see: if the app's
 * role ever loses visibility of other backends' `xact_start` (it has it today —
 * every connection uses the same role), those rows read NULL and drop out of the
 * `min`, leaving the lag as the bound.
 */
function settledBefore(visibilityLagMs: number) {
  // Lag inlined rather than bound: an integer we just validated, and a literal
  // keeps the interval's type unambiguous.
  return sql`least(
    now() - ${sql.raw(String(visibilityLagMs))} * interval '1 millisecond',
    coalesce(
      (
        select min(activity.xact_start)
        from pg_stat_activity as activity
        where activity.datname = current_database()
          and activity.xact_start is not null
      ),
      now()
    )
  )`;
}

function boundedCount(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function boundedLagMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return TRACE_SUMMARY_VISIBILITY_LAG_MS;
  }
  return Math.min(MAX_INTERVAL_MS, Math.max(0, Math.trunc(value)));
}
