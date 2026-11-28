import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import { featureEnabled } from "@/lib/platform/experimental-features";
import { getLogger } from "@/lib/platform/logger";
import { notOnHold } from "@/lib/platform/org-hold/sql";
import {
  evaluationIntervalMs,
  evaluationWindow,
  type Measurement,
  nextState,
} from "@/lib/views/alerts/domain";
import { storedQuery } from "@/lib/views/alerts/parse-rule";
import { alertEvents, alertRules } from "@/lib/views/alerts/schema";
import { measureSqlValue } from "@/lib/views/alerts/sql-value";
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
  /** Wall-clock one project's rules may spend in one tick; the rest wait for the next tick. */
  projectBudgetMs?: number;
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
  /** Rules whose evaluation threw, and RQL rules whose query RQL refused (marked with the error). */
  failed: number;
  /** Rules whose stored query is malformed. */
  skipped: { projectId: string; ruleId: string }[];
  changes: StateChange[];
  /** Another tick held the advisory lock. */
  lockContended: boolean;
}

export const EVALUATION_TIME_BUDGET_MS = 20_000;
/**
 * The share of a tick one project's rules may take: the slow RQL rules of one project never hold
 * the rules of the others for more than this. Each RQL rule stops at `RQL_LIMITS.alertTimeoutMs`.
 */
export const PROJECT_TIME_BUDGET_MS = 5_000;
/** Arbitrary but stable; only this evaluator takes it. */
const ALERTS_ADVISORY_LOCK_KEY = 823_100_132;

const logger = getLogger("alerts/evaluate");

/**
 * Evaluate the due rules of the projects with the flag on, the one that waited longest first, one
 * rule of each project in turn, so no project waits behind another's rules. A project stops for the
 * tick once its rules spent `projectBudgetMs`. Each rule is one transaction under an advisory lock
 * and its row lock: the state, its history row and
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

  const projectBudgetMs = options.projectBudgetMs ?? PROJECT_TIME_BUDGET_MS;
  const spent = new Map<string, number>();
  const due = inTurns(await dueRules(db, now(), options.flagOn ?? flagOn));
  for (const rule of due) {
    if (Date.now() - startedAt >= timeBudgetMs) return result;
    if ((spent.get(rule.projectId) ?? 0) >= projectBudgetMs) continue;
    const ruleStarted = Date.now();
    try {
      const read = await readSqlFirst(db, rule.id, now());
      const outcome = await db.transaction((tx) => evaluateOne(tx, rule.id, now(), read));
      if (outcome === "locked") return { ...result, lockContended: true };
      if (outcome === "gone") continue;
      if (outcome === "skipped") {
        result.skipped.push({ projectId: rule.projectId, ruleId: rule.id });
        continue;
      }
      if (outcome === "failing") {
        result.failed += 1;
        continue;
      }
      result.evaluated += 1;
      if (outcome.change) result.changes.push(outcome.change);
    } catch (err) {
      result.failed += 1;
      logger.error({ err, project_id: rule.projectId, rule_id: rule.id }, "alert rule failed");
      await db.update(alertRules).set({ lastEvaluatedAt: now() }).where(eq(alertRules.id, rule.id));
    } finally {
      spent.set(rule.projectId, (spent.get(rule.projectId) ?? 0) + Date.now() - ruleStarted);
    }
  }
  return result;
}

/** The rules in turns: the first due rule of each project, then the second of each, and so on. */
function inTurns<Rule extends { projectId: string }>(rules: readonly Rule[]): Rule[] {
  const byProject = new Map<string, Rule[]>();
  for (const rule of rules) {
    const list = byProject.get(rule.projectId) ?? [];
    list.push(rule);
    byProject.set(rule.projectId, list);
  }
  const lists = [...byProject.values()];
  const turns: Rule[] = [];
  for (let turn = 0; turns.length < rules.length; turn++)
    for (const list of lists) {
      const rule = list[turn];
      if (rule) turns.push(rule);
    }
  return turns;
}

async function dueRules(
  db: Db,
  now: Date,
  on: (projectId: string) => Promise<boolean>,
): Promise<{ id: string; projectId: string }[]> {
  const rows = await db
    .select({ id: alertRules.id, projectId: alertRules.projectId })
    .from(alertRules)
    .where(and(dueAt(now), notOnHold(alertRules.projectId)))
    .orderBy(sql`${alertRules.lastEvaluatedAt} asc nulls first`, asc(alertRules.id));
  const flags = new Map<string, boolean>();
  for (const { projectId } of rows)
    if (!flags.has(projectId)) flags.set(projectId, await on(projectId));
  return rows.filter(({ projectId }) => flags.get(projectId));
}

/** The value of an RQL rule, read before its transaction, with the query it was read for. */
interface SqlRead {
  query: string;
  measured: Measurement | { error: string };
}

/**
 * Every rule reads on the RQL pool before its transaction, on the alert path: a query of up to its
 * own timeout must hold no row lock and no connection of the primary pool. Null for a rule that is
 * not due, or whose stored query fails.
 */
async function readSqlFirst(db: Db, ruleId: string, now: Date): Promise<SqlRead | null> {
  const [rule] = await db
    .select({
      projectId: alertRules.projectId,
      query: alertRules.query,
      windowMinutes: alertRules.windowMinutes,
    })
    .from(alertRules)
    .where(and(eq(alertRules.id, ruleId), dueAt(now)));
  const query = rule && storedQuery(rule.query).query;
  if (!query) return null;
  return {
    query: JSON.stringify(query),
    measured: await measureSqlValue(
      rule.projectId,
      query,
      evaluationWindow(rule.windowMinutes, now),
      { reserved: true },
    ),
  };
}

async function evaluateOne(
  tx: Tx,
  ruleId: string,
  now: Date,
  read: SqlRead | null,
): Promise<"locked" | "gone" | "skipped" | "failing" | { change: StateChange | null }> {
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
  // Changed since it was read: the next tick reads it again.
  if (read?.query !== JSON.stringify(query)) return "gone";
  const measured: Measurement | { error: string } = read.measured;
  if ("error" in measured) {
    // Failing, not firing: the state and the last value stay, and the rule says why.
    await tx
      .update(alertRules)
      .set({ lastError: measured.error, lastEvaluatedAt: now })
      .where(eq(alertRules.id, rule.id));
    return "failing";
  }
  const next = nextState(rule, rule, measured);
  await tx
    .update(alertRules)
    .set({
      state: next.state,
      firing: next.firing,
      lastValue: next.value,
      lastError: null,
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
      metric: query.form?.measures[0].measure ?? "sql",
      from: rule.state,
      to: next.state,
      notice: next.notice,
    },
  };
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
