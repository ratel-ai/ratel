import { asc, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import { featureEnabled } from "@/lib/platform/experimental-features";
import { getLogger } from "@/lib/platform/logger";
import { settledBefore } from "@/lib/synthesis/traces/summary-refresh";
import { runCheck } from "./check";
import { JUDGE_BATCH_SIZE, type JudgeDeps, judgeTraces } from "./judge";
import { inSample } from "./sample";
import { traceScorers } from "./schema";
import {
  insertTraceScores,
  type NewTraceScore,
  type ScorerDb,
  scoredTraceIds,
  scorerOf,
} from "./store";
import { filterCondition, loadScorerTraces, rowsOf } from "./traces";
import type { ScoreOutcome, Scorer, ScorerTrace } from "./types";

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
  judge?: JudgeDeps;
}

/** The traces of one scorer that got no judge result because the daily budget is spent. */
export interface BudgetSkip {
  projectId: string;
  scorerId: string;
  traces: number;
}

export interface SweepResult {
  scorers: number;
  tracesScanned: number;
  scoresWritten: number;
  /** Matching, sampled traces that got no result (a missing attribute, for example). */
  skipped: number;
  failedScorers: number;
  budgetSkips: BudgetSkip[];
  /** Every scorer reached the end of the settled traces. */
  caughtUp: boolean;
  /** Another tick held the advisory lock. */
  lockContended: boolean;
}

interface Batch {
  scanned: number;
  /** More settled traces may be left. */
  more: boolean;
  written: number;
  skipped: number;
  /** Judge only: what the model has to answer, after the transaction. */
  toJudge: ScorerTrace[];
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
 * creation. A check's results commit with the cursor. A judge's cursor commits before its calls, so
 * no transaction is open during one, and no two ticks pay for the same trace; a crash in between
 * loses at most one batch of results. A result is unique per scorer and trace, so a repeated tick or
 * a summary written again adds nothing. Scorers take turns, one batch each, so a busy project does
 * not hold up the others.
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
    budgetSkips: [],
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
        const answered = await judgeBatch(scorer, batch.toJudge, options.judge, result, db);
        if (batch.more && answered) behind.push(scorer);
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
      join trace_scorers c on c.id = ${scorer.id} and c.enabled
      where s.project_id = ${scorer.projectId}
        and (s.updated_at, s.trace_id) > (c.cursor_at, c.cursor_trace_id)
        and s.updated_at < ${settledBefore(settleMs)}
      order by s.updated_at, s.trace_id
      limit ${batchSize}`),
  );
  const sampled = slice.filter(
    (row) => row.matches && inSample(scorer.id, row.trace_id, scorer.sampleRate),
  );
  // A judge takes a few traces at a time: the cursor stops at the last one it takes.
  const overflow = scorer.kind === "judge" ? sampled.at(JUDGE_BATCH_SIZE) : undefined;
  const taken = overflow ? slice.slice(0, slice.indexOf(overflow)) : slice;
  const last = taken.at(-1);
  if (!last) return { scanned: 0, more: false, written: 0, skipped: 0, toJudge: [] };

  const chosen = sampled.slice(0, overflow ? JUDGE_BATCH_SIZE : undefined);
  const traces = await loadScorerTraces(
    scorer.projectId,
    chosen.map((row) => row.trace_id),
    tx,
  );
  await tx
    .update(traceScorers)
    .set({ cursorAt: last.updated_at, cursorTraceId: last.trace_id })
    .where(eq(traceScorers.id, scorer.id));
  const batch = {
    scanned: taken.length,
    more: overflow !== undefined || slice.length === batchSize,
  };
  if (scorer.kind === "judge") {
    const done = await scoredTraceIds(
      scorer.id,
      traces.map((trace) => trace.traceId),
      tx,
    );
    const toJudge = traces.filter((trace) => !done.has(trace.traceId));
    return { ...batch, written: 0, skipped: 0, toJudge };
  }
  const { config } = scorer;
  const scores = scoresOf(
    scorer,
    traces,
    traces.map((trace) => runCheck(config, trace)),
  );
  const written = await insertTraceScores(scores, tx);
  return { ...batch, written, skipped: traces.length - scores.length, toJudge: [] };
}

/** Judge a claimed batch and store its results. False when the model answered none of it. */
async function judgeBatch(
  scorer: Scorer,
  traces: readonly ScorerTrace[],
  deps: JudgeDeps | undefined,
  result: SweepResult,
  db: Db,
): Promise<boolean> {
  if (scorer.kind !== "judge" || traces.length === 0) return true;
  const outcomes = await judgeTraces(scorer.projectId, scorer.config, traces, deps, db);
  const scores = scoresOf(scorer, traces, outcomes);
  result.scoresWritten += await insertTraceScores(scores, db);
  result.skipped += traces.length - scores.length;

  const reasons = outcomes.map((outcome) => (outcome.status === "skipped" ? outcome.reason : null));
  const unpaid = reasons.filter((reason) => reason === "budget_spent").length;
  if (unpaid > 0) {
    const known = result.budgetSkips.find((skip) => skip.scorerId === scorer.id);
    if (known) known.traces += unpaid;
    else
      result.budgetSkips.push({ projectId: scorer.projectId, scorerId: scorer.id, traces: unpaid });
  }
  // An engine that is down is asked again on the next tick, not for the whole backlog now.
  return reasons.some((reason) => reason !== "no_answer");
}

function scoresOf(
  scorer: Scorer,
  traces: readonly ScorerTrace[],
  outcomes: readonly ScoreOutcome[],
): NewTraceScore[] {
  return traces.flatMap((trace, index) => {
    const outcome = outcomes[index];
    if (outcome?.status !== "scored") return [];
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
    .from(traceScorers)
    .where(eq(traceScorers.enabled, true))
    .orderBy(asc(traceScorers.cursorAt), asc(traceScorers.id));
  const on = new Map<string, boolean>();
  for (const { projectId } of rows)
    if (!on.has(projectId)) on.set(projectId, await flagOn(projectId));
  return rows.flatMap((row) => (on.get(row.projectId) ? (scorerOf(row) ?? []) : []));
}

function scorersFlagOn(projectId: string): Promise<boolean> {
  return featureEnabled("scorers", { projectId });
}
