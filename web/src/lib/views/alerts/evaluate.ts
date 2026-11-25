import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import type { MetricQuery } from "@/lib/contracts/query";
import { getDb } from "@/lib/platform/db/client";
import { supplementaryReadTimeoutMs } from "@/lib/platform/db/statement-timeout";
import { featureEnabled } from "@/lib/platform/experimental-features";
import { getLogger } from "@/lib/platform/logger";
import type { QueryScope } from "@/lib/synthesis/metrics/catalog";
import { runQuery } from "@/lib/synthesis/metrics/query";
import {
  evaluationIntervalMs,
  evaluationWindow,
  type Measurement,
  nextState,
} from "@/lib/views/alerts/domain";
import { storedQuery } from "@/lib/views/alerts/parse-rule";
import { alertEvents, alertRules } from "@/lib/views/alerts/schema";
import { ALERT_WINDOWS, type AlertNoticeKind, type AlertState } from "@/lib/views/alerts/types";
// The scorer metrics read through the source this module registers.
import "@/lib/views/scorers/metrics";

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface EvaluateOptions {
  now?: () => Date;
  /** Wall-clock the evaluation may spend before it yields to the next tick. */
  timeBudgetMs?: number;
  flagOn?: (projectId: string) => Promise<boolean>;
}

export interface StateChange {
  projectId: string;
  ruleId: string;
  metric: string;
  from: AlertState;
  to: AlertState;
  notice: AlertNoticeKind | null;
}

export interface EvaluationResult {
  evaluated: number;
  failed: number;
  /** Rules whose stored query is malformed. */
  skipped: { projectId: string; ruleId: string }[];
  changes: StateChange[];
  /** Another tick held the advisory lock. */
  lockContended: boolean;
}

export const EVALUATION_TIME_BUDGET_MS = 20_000;
/** Arbitrary but stable; only this evaluator takes it. */
const ALERTS_ADVISORY_LOCK_KEY = 823_100_132;

const logger = getLogger("alerts/evaluate");

/**
 * Evaluate the due rules of the projects with the flag on, the one that waited longest first. Each
 * rule is one transaction under an advisory lock and its row lock: the state, its history row and
 * the message to send commit together, so a change is recorded, and sent, once. A rule that fails
 * waits for its next turn and does not stop the others; one whose stored query is malformed is skipped.
 */
export async function evaluateAlerts(
  options: EvaluateOptions = {},
  db: Db = getDb(),
): Promise<EvaluationResult> {
  const now = options.now ?? (() => new Date());
  const timeBudgetMs = options.timeBudgetMs ?? EVALUATION_TIME_BUDGET_MS;
  const startedAt = Date.now();
  const result: EvaluationResult = {
    evaluated: 0,
    failed: 0,
    skipped: [],
    changes: [],
    lockContended: false,
  };

  const due = await dueRules(db, now(), options.flagOn ?? flagOn);
  for (const rule of due) {
    if (Date.now() - startedAt >= timeBudgetMs) return result;
    try {
      const outcome = await db.transaction((tx) => evaluateOne(tx, rule.id, now()));
      if (outcome === "locked") return { ...result, lockContended: true };
      if (outcome === "gone") continue;
      if (outcome === "skipped") {
        result.skipped.push({ projectId: rule.projectId, ruleId: rule.id });
        continue;
      }
      result.evaluated += 1;
      if (outcome.change) result.changes.push(outcome.change);
    } catch (err) {
      result.failed += 1;
      logger.error({ err, project_id: rule.projectId, rule_id: rule.id }, "alert rule failed");
      await db.update(alertRules).set({ lastEvaluatedAt: now() }).where(eq(alertRules.id, rule.id));
    }
  }
  return result;
}

async function dueRules(
  db: Db,
  now: Date,
  on: (projectId: string) => Promise<boolean>,
): Promise<{ id: string; projectId: string }[]> {
  const rows = await db
    .select({ id: alertRules.id, projectId: alertRules.projectId })
    .from(alertRules)
    .where(dueAt(now))
    .orderBy(sql`${alertRules.lastEvaluatedAt} asc nulls first`, asc(alertRules.id));
  const flags = new Map<string, boolean>();
  for (const { projectId } of rows)
    if (!flags.has(projectId)) flags.set(projectId, await on(projectId));
  return rows.filter(({ projectId }) => flags.get(projectId));
}

async function evaluateOne(
  tx: Tx,
  ruleId: string,
  now: Date,
): Promise<"locked" | "gone" | "skipped" | { change: StateChange | null }> {
  const locked = await tx.execute(
    sql`select pg_try_advisory_xact_lock(${ALERTS_ADVISORY_LOCK_KEY}::bigint) as locked`,
  );
  if (firstRow<{ locked: boolean }>(locked)?.locked !== true) return "locked";
  // Read again under the row lock: paused, deleted or evaluated since the list was made.
  const [rule] = await tx
    .select()
    .from(alertRules)
    .where(and(eq(alertRules.id, ruleId), dueAt(now)))
    .for("update");
  if (!rule) return "gone";

  const { query } = storedQuery(rule.query);
  if (!query) {
    await tx.update(alertRules).set({ lastEvaluatedAt: now }).where(eq(alertRules.id, rule.id));
    return "skipped";
  }
  const window = evaluationWindow(rule.windowMinutes, now);
  const measured = await measure(tx, rule.projectId, query, window);
  const next = nextState(rule, rule, measured);
  await tx
    .update(alertRules)
    .set({
      state: next.state,
      firing: next.firing,
      lastValue: next.value,
      lastEvaluatedAt: now,
      ...(next.changed ? { stateChangedAt: now } : {}),
    })
    .where(eq(alertRules.id, rule.id));
  if (!next.changed) return { change: null };
  await tx.insert(alertEvents).values({
    ruleId: rule.id,
    fromState: rule.state,
    toState: next.state,
    value: next.value,
    operator: rule.operator,
    threshold: rule.threshold,
    windowMinutes: rule.windowMinutes,
    at: now,
    notice: next.notice,
    delivery: next.notice ? "pending" : "none",
  });
  return {
    change: {
      projectId: rule.projectId,
      ruleId: rule.id,
      metric: query.measures[0].measure,
      from: rule.state,
      to: next.state,
      notice: next.notice,
    },
  };
}

async function measure(
  tx: Tx,
  projectId: string,
  query: MetricQuery,
  window: QueryScope,
): Promise<Measurement> {
  await tx.execute(
    sql`select set_config('statement_timeout', ${String(supplementaryReadTimeoutMs() ?? 0)}, true)`,
  );
  const { series } = await runQuery(projectId, query, window, tx);
  const [only] = series;
  return { value: only.total };
}

function dueAt(now: Date) {
  const waits = ALERT_WINDOWS.map((minutes) => ({ minutes, ms: evaluationIntervalMs(minutes) }));
  return and(
    eq(alertRules.enabled, true),
    or(
      sql`${alertRules.lastEvaluatedAt} is null`,
      ...[...new Set(waits.map(({ ms }) => ms))].map((ms) =>
        and(
          inArray(
            alertRules.windowMinutes,
            waits.filter((wait) => wait.ms === ms).map(({ minutes }) => minutes),
          ),
          sql`${alertRules.lastEvaluatedAt} <= ${new Date(now.getTime() - ms).toISOString()}::timestamptz`,
        ),
      ),
    ),
  );
}

function flagOn(projectId: string): Promise<boolean> {
  return featureEnabled("customMonitoring", { projectId });
}

function firstRow<T>(result: unknown): T | undefined {
  return ((result as { rows?: T[] }).rows ?? (result as T[]))[0];
}
