import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import { featureEnabled } from "@/lib/platform/experimental-features";
import { getLogger } from "@/lib/platform/logger";
import { CLOSED_SINCE_SLACK_MS } from "@/lib/readings/trace-signals/sweep";
import { settledBefore } from "@/lib/synthesis/traces/summary-refresh";
import type { EvalDb } from "@/lib/views/eval-gate/runs";
import { runCheck } from "./check";
import { JUDGE_BATCH_SIZE, type JudgeDeps, judgeTraces, resolveJudgeEngine } from "./judge";
import { scorePresetTraces } from "./preset";
import { inSample } from "./sample";
import { traceScorers } from "./schema";
import {
  insertTraceScores,
  type NewTraceScore,
  type ScorerDb,
  scoredTraceIds,
  scorersOf,
} from "./store";
import { loadScorerTraces, rowsOf, targetCondition } from "./traces";
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
  /** Judge only: the cursor before the batch, and how often the batch was asked without an answer. */
  from: { cursorAt: string; cursorTraceId: string; attempts: number };
}

export const SWEEP_BATCH_SIZE = 500;
export const SWEEP_TIME_BUDGET_MS = 20_000;
/** Under one 60-second tick, so a trace is scored within about two ticks of its last span. */
export const SWEEP_SETTLE_MS = 45_000;
/**
 * How often a judge asks for one batch that gets no answer at all, before its traces are given up.
 * The wait between two attempts doubles from a minute to an hour, so this is about 19 hours.
 */
export const MAX_JUDGE_ATTEMPTS = 24;
const FIRST_RETRY_MS = 60_000;
const LAST_RETRY_MS = 3_600_000;
/** Arbitrary but stable; only this sweep takes it. */
const SWEEP_ADVISORY_LOCK_KEY = 823_100_124;

const NO_ATTEMPTS = { judgeAttempts: 0, judgeRetryAt: null };
const UNASKED_OR_FAILED: ReadonlySet<string> = new Set([
  "call_failed",
  "no_content",
  "budget_spent",
]);
const EMPTY_BATCH: Batch = {
  scanned: 0,
  more: false,
  written: 0,
  skipped: 0,
  toJudge: [],
  from: { cursorAt: "", cursorTraceId: "", attempts: 0 },
};

const logger = getLogger("scorers/sweep");

/**
 * Score the settled traces each enabled scorer has not read yet. Each scorer has its own
 * `(updated_at, trace_id)` cursor over `otel_trace_summaries`, so a new scorer starts at its
 * creation. A check's results commit with the cursor. A judge's cursor commits before its calls, so
 * no transaction is open during one, and no two ticks pay for the same trace; a crash in between
 * loses at most one batch of results. A batch whose every call fails puts the cursor back and is
 * asked again later, up to `MAX_JUDGE_ATTEMPTS` times; without an engine a judge does not move. A
 * result is unique per scorer and trace, so a repeated tick or
 * a summary written again adds nothing. Scorers take turns, one batch each, so a busy project does
 * not hold up the others. A scorer of tasks waits at the traces whose turns have no task yet.
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

  const judge = { ...options.judge };
  if (judge.engine === undefined) judge.engine = resolveJudgeEngine();
  let pending = (
    await activeScorers(db, options.flagOn ?? scorersFlagOn, new Date(startedAt))
  ).filter((scorer) => scorer.kind !== "judge" || judge.engine !== null);
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
        const answered = await judgeBatch(scorer, batch, judge, result, db, now);
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
  tx: ScorerDb & EvalDb,
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

  const slice = rowsOf<{
    trace_id: string;
    updated_at: string;
    matches: boolean;
    cursor_at: string;
    cursor_trace_id: string;
    judge_attempts: number;
  }>(
    await tx.execute(sql`
      select s.trace_id, s.updated_at::text as updated_at,
        c.cursor_at::text as cursor_at, c.cursor_trace_id, c.judge_attempts,
        (s.spans_max_received_at >= c.created_at and ${targetCondition(scorer.projectId, scorer)}) as matches
      from otel_trace_summaries s
      join trace_scorers c on c.id = ${scorer.id} and c.enabled
      where s.project_id = ${scorer.projectId}
        and (s.updated_at, s.trace_id) > (c.cursor_at, c.cursor_trace_id)
        and s.updated_at < ${settledBefore(settleMs)}
        ${scorer.tasks ? sql`and s.updated_at < ${placedBefore(scorer.projectId)}` : sql``}
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
  if (!last) return EMPTY_BATCH;

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
    from: {
      cursorAt: last.cursor_at,
      cursorTraceId: last.cursor_trace_id,
      attempts: last.judge_attempts,
    },
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
  const outcomes =
    scorer.kind === "preset"
      ? await scorePresetTraces(scorer.projectId, scorer.config, traces, scorer.tasks ?? [], tx)
      : traces.map((trace) => runCheck(scorer.config, trace));
  const scores = scoresOf(scorer, traces, outcomes);
  const written = await insertTraceScores(scores, tx);
  return { ...batch, written, skipped: traces.length - scores.length, toJudge: [] };
}

/**
 * Up to when a trace's turn has its task, if it belongs to one: a signal run writes the task of
 * each turn that closed before it (`trace_turns.workflow_id`). Null, so nothing, before the first.
 */
function placedBefore(projectId: string) {
  return sql`(
    select max(least(r.window_end, r.ledger_through)) - ${sql.raw(String(CLOSED_SINCE_SLACK_MS))} * interval '1 millisecond'
    from trace_signal_runs r
    where r.project_id = ${projectId} and r.status = 'completed')`;
}

/** Judge a claimed batch and store its results. False when the batch is to be asked again. */
async function judgeBatch(
  scorer: Scorer,
  { toJudge: traces, from }: Batch,
  deps: JudgeDeps,
  result: SweepResult,
  db: Db,
  now: () => number,
): Promise<boolean> {
  if (scorer.kind !== "judge" || traces.length === 0) return true;
  let outcomes: ScoreOutcome[];
  try {
    outcomes = await judgeTraces(scorer.projectId, scorer.config, traces, deps, db);
  } catch (err) {
    await askAgain(scorer, from, now(), db);
    throw err;
  }
  const scores = scoresOf(scorer, traces, outcomes);
  result.scoresWritten += await insertTraceScores(scores, db);

  const reasons = outcomes.map((outcome) => (outcome.status === "skipped" ? outcome.reason : null));
  const unanswered =
    reasons.includes("call_failed") &&
    reasons.every((reason) => reason !== null && UNASKED_OR_FAILED.has(reason));
  const again = unanswered && (await askAgain(scorer, from, now(), db));
  if (!unanswered && from.attempts > 0)
    await db.update(traceScorers).set(NO_ATTEMPTS).where(eq(traceScorers.id, scorer.id));
  if (!again) result.skipped += traces.length - scores.length;

  const unpaid = reasons.filter((reason) => reason === "budget_spent").length;
  if (unpaid > 0) {
    const known = result.budgetSkips.find((skip) => skip.scorerId === scorer.id);
    if (known) known.traces += unpaid;
    else
      result.budgetSkips.push({ projectId: scorer.projectId, scorerId: scorer.id, traces: unpaid });
  }
  // An engine that is down is asked again on a later tick, not for the whole backlog now.
  return !unanswered;
}

/** Put the cursor back before a batch that got no answer. False after its last attempt: it is given up. */
async function askAgain(
  scorer: Scorer,
  from: Batch["from"],
  now: number,
  db: Db,
): Promise<boolean> {
  const attempts = from.attempts + 1;
  if (attempts >= MAX_JUDGE_ATTEMPTS) {
    await db.update(traceScorers).set(NO_ATTEMPTS).where(eq(traceScorers.id, scorer.id));
    logger.error(
      { project_id: scorer.projectId, scorer_id: scorer.id, attempts },
      "judge batch given up",
    );
    return false;
  }
  const waitMs = Math.min(LAST_RETRY_MS, FIRST_RETRY_MS * 2 ** (attempts - 1));
  await db
    .update(traceScorers)
    .set({
      cursorAt: from.cursorAt,
      cursorTraceId: from.cursorTraceId,
      judgeAttempts: attempts,
      judgeRetryAt: new Date(now + waitMs),
    })
    // Never forward: another tick may have put it further back.
    .where(
      and(
        eq(traceScorers.id, scorer.id),
        sql`(${traceScorers.cursorAt}, ${traceScorers.cursorTraceId}) > (${from.cursorAt}::timestamptz, ${from.cursorTraceId})`,
      ),
    );
  return true;
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

/** The enabled scorers of the projects whose flag is on, but those that wait, the one furthest behind first. */
async function activeScorers(
  db: Db,
  flagOn: (projectId: string) => Promise<boolean>,
  now: Date,
): Promise<Scorer[]> {
  const rows = await db
    .select()
    .from(traceScorers)
    .where(
      and(
        eq(traceScorers.enabled, true),
        or(isNull(traceScorers.judgeRetryAt), lte(traceScorers.judgeRetryAt, now)),
      ),
    )
    .orderBy(asc(traceScorers.cursorAt), asc(traceScorers.id));
  const on = new Map<string, boolean>();
  for (const { projectId } of rows)
    if (!on.has(projectId)) on.set(projectId, await flagOn(projectId));
  return scorersOf(
    rows.filter((row) => on.get(row.projectId)),
    db,
  );
}

function scorersFlagOn(projectId: string): Promise<boolean> {
  return featureEnabled("customMonitoring", { projectId });
}
