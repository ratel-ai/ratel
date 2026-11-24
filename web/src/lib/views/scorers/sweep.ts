import { and, asc, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import { featureEnabled } from "@/lib/platform/experimental-features";
import { getLogger } from "@/lib/platform/logger";
import { settledBefore } from "@/lib/synthesis/traces/summary-refresh";
import { runCheck } from "./check";
import { inSample } from "./sample";
import { scorers } from "./schema";
import { insertTraceScores, type NewTraceScore, type ScorerDb, scorerOf } from "./store";
import { filterCondition, loadScorerTraces, rowsOf } from "./traces";
import type { Scorer, ScorerTrace } from "./types";

type Db = ReturnType<typeof getDb>;

export interface SweepOptions {
  /** Trace summaries read per scorer and batch. */
  batchSize?: number;
  /** Wall-clock the whole sweep may spend before it yields to the next tick. */
  timeBudgetMs?: number;
  /** A trace is taken when its summary did not change for this long. */
  settleMs?: number;
  now?: () => number;
  flagOn?: (projectId: string) => Promise<boolean>;
}

export interface SweepResult {
  scorers: number;
  tracesScanned: number;
  scoresWritten: number;
  /** Matching, sampled traces that got no result (a missing attribute, for example). */
  skipped: number;
  failedScorers: number;
  /** Every scorer reached the end of the settled traces. */
  caughtUp: boolean;
  /** Another tick held the advisory lock. */
  lockContended: boolean;
}

interface Batch {
  scanned: number;
  traces: ScorerTrace[];
  written: number;
  skipped: number;
}

export const SWEEP_BATCH_SIZE = 500;
export const SWEEP_TIME_BUDGET_MS = 20_000;
/** Under one 60-second tick, so a trace is scored within about two ticks of its last span. */
export const SWEEP_SETTLE_MS = 45_000;
/** Arbitrary but stable; only this sweep takes it. */
const SWEEP_ADVISORY_LOCK_KEY = 823_100_124;

const logger = getLogger("scorers/sweep");

/**
 * Score the settled traces each enabled scorer has not read yet. Each scorer has its own
 * `(updated_at, trace_id)` cursor over `otel_trace_summaries`, so a new scorer starts at its
 * creation. The cursor and the results commit together, and a result is unique per scorer and
 * trace, so a repeated tick or a summary written again adds nothing. Scorers take turns, one batch
 * each, so a busy project does not hold up the others.
 */
export async function sweepScorers(
  options: SweepOptions = {},
  db: Db = getDb(),
): Promise<SweepResult> {
  const batchSize = options.batchSize ?? SWEEP_BATCH_SIZE;
  const timeBudgetMs = options.timeBudgetMs ?? SWEEP_TIME_BUDGET_MS;
  const settleMs = options.settleMs ?? SWEEP_SETTLE_MS;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const result: SweepResult = {
    scorers: 0,
    tracesScanned: 0,
    scoresWritten: 0,
    skipped: 0,
    failedScorers: 0,
    caughtUp: false,
    lockContended: false,
  };

  let pending = await activeScorers(db, options.flagOn ?? scorersFlagOn);
  result.scorers = pending.length;
  while (pending.length > 0) {
    const behind: Scorer[] = [];
    for (const scorer of pending) {
      if (now() - startedAt >= timeBudgetMs) return result;
      try {
        const batch = await db.transaction((tx) => sweepOneBatch(tx, scorer, batchSize, settleMs));
        if (batch === null) return { ...result, lockContended: true };
        result.tracesScanned += batch.scanned;
        result.scoresWritten += batch.written;
        result.skipped += batch.skipped;
        if (batch.scanned === batchSize) behind.push(scorer);
      } catch (err) {
        // The next tick tries this scorer again from its cursor; the others go on now.
        result.failedScorers += 1;
        logger.error(
          { err, project_id: scorer.projectId, scorer_id: scorer.id },
          "scorer batch failed",
        );
      }
    }
    pending = behind;
  }
  return { ...result, caughtUp: true };
}

/** One transaction: claim the lock, read a slice of summaries, score, advance the cursor. */
async function sweepOneBatch(
  tx: ScorerDb,
  scorer: Scorer,
  batchSize: number,
  settleMs: number,
): Promise<Batch | null> {
  const [lock] = rowsOf<{ locked: boolean }>(
    await tx.execute(
      sql`select pg_try_advisory_xact_lock(${SWEEP_ADVISORY_LOCK_KEY}::bigint) as locked`,
    ),
  );
  if (lock?.locked !== true) return null;

  const slice = rowsOf<{ trace_id: string; updated_at: string; matches: boolean }>(
    await tx.execute(sql`
      select s.trace_id, s.updated_at::text as updated_at,
        (s.spans_max_received_at >= c.created_at and ${filterCondition(scorer.filter)}) as matches
      from otel_trace_summaries s
      join scorers c on c.id = ${scorer.id} and c.enabled
      where s.project_id = ${scorer.projectId}
        and (s.updated_at, s.trace_id) > (c.cursor_at, c.cursor_trace_id)
        and s.updated_at < ${settledBefore(settleMs)}
      order by s.updated_at, s.trace_id
      limit ${batchSize}`),
  );
  const last = slice.at(-1);
  if (!last) return { scanned: 0, traces: [], written: 0, skipped: 0 };

  const traces = await loadScorerTraces(
    scorer.projectId,
    slice
      .filter((row) => row.matches && inSample(scorer.id, row.trace_id, scorer.sampleRate))
      .map((row) => row.trace_id),
    tx,
  );
  const scores = checkScores(scorer, traces);
  const written = await insertTraceScores(scores, tx);
  await tx
    .update(scorers)
    .set({ cursorAt: last.updated_at, cursorTraceId: last.trace_id })
    .where(eq(scorers.id, scorer.id));
  return { scanned: slice.length, traces, written, skipped: traces.length - scores.length };
}

function checkScores(scorer: Scorer, traces: readonly ScorerTrace[]): NewTraceScore[] {
  if (scorer.kind !== "check") return [];
  return traces.flatMap((trace) => {
    const outcome = runCheck(scorer.config, trace);
    if (outcome.status === "skipped") return [];
    return {
      ...outcome.score,
      scorerId: scorer.id,
      projectId: scorer.projectId,
      traceId: trace.traceId,
      traceStartedAt: trace.startedAt,
    };
  });
}

/** The enabled scorers of the projects whose flag is on, the one furthest behind first. */
async function activeScorers(
  db: Db,
  flagOn: (projectId: string) => Promise<boolean>,
): Promise<Scorer[]> {
  const rows = await db
    .select()
    .from(scorers)
    .where(and(eq(scorers.enabled, true), eq(scorers.kind, "check")))
    .orderBy(asc(scorers.cursorAt), asc(scorers.id));
  const on = new Map<string, boolean>();
  for (const { projectId } of rows)
    if (!on.has(projectId)) on.set(projectId, await flagOn(projectId));
  return rows.flatMap((row) => (on.get(row.projectId) ? (scorerOf(row) ?? []) : []));
}

function scorersFlagOn(projectId: string): Promise<boolean> {
  return featureEnabled("scorers", { projectId });
}
