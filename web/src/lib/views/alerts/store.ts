import { and, asc, count, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import { alertEvents, alertRules } from "@/lib/views/alerts/schema";
import type { AlertDraft, AlertRule } from "@/lib/views/alerts/types";

export type AlertsDb = Pick<
  ReturnType<typeof getDb>,
  "select" | "insert" | "update" | "delete" | "transaction" | "execute"
>;

const RULE = {
  id: alertRules.id,
  projectId: alertRules.projectId,
  name: alertRules.name,
  query: alertRules.query,
  operator: alertRules.operator,
  threshold: alertRules.threshold,
  windowMinutes: alertRules.windowMinutes,
  enabled: alertRules.enabled,
  state: alertRules.state,
  firing: alertRules.firing,
  lastValue: alertRules.lastValue,
  stateChangedAt: alertRules.stateChangedAt,
};

/** Oldest first, so the list does not move as rules change state. */
export async function listAlertRules(
  projectId: string,
  db: AlertsDb = getDb(),
): Promise<AlertRule[]> {
  return db
    .select(RULE)
    .from(alertRules)
    .where(eq(alertRules.projectId, projectId))
    .orderBy(asc(alertRules.createdAt), asc(alertRules.id));
}

export async function getAlertRule(
  projectId: string,
  id: string,
  db: AlertsDb = getDb(),
): Promise<AlertRule | null> {
  const [row] = await db.select(RULE).from(alertRules).where(inProject(projectId, id));
  return row ?? null;
}

export async function countAlertRules(projectId: string, db: AlertsDb = getDb()): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(alertRules)
    .where(eq(alertRules.projectId, projectId));
  return row.n;
}

export async function createAlertRule(
  projectId: string,
  draft: AlertDraft,
  actor: string,
  db: AlertsDb = getDb(),
): Promise<string> {
  const [row] = await db
    .insert(alertRules)
    .values({ ...draft, projectId, createdBy: actor, updatedBy: actor })
    .returning({ id: alertRules.id });
  return row.id;
}

/** False when the project has no such rule, as for every change below. The next tick evaluates it. */
export async function updateAlertRule(
  projectId: string,
  id: string,
  draft: AlertDraft,
  actor: string,
  db: AlertsDb = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(alertRules)
    .set({ ...draft, lastEvaluatedAt: null, updatedBy: actor, updatedAt: sql`now()` })
    .where(inProject(projectId, id))
    .returning({ id: alertRules.id });
  return rows.length > 0;
}

export async function setAlertRuleEnabled(
  projectId: string,
  id: string,
  enabled: boolean,
  actor: string,
  db: AlertsDb = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(alertRules)
    .set({ enabled, lastEvaluatedAt: null, updatedBy: actor, updatedAt: sql`now()` })
    .where(inProject(projectId, id))
    .returning({ id: alertRules.id });
  return rows.length > 0;
}

export async function deleteAlertRule(
  projectId: string,
  id: string,
  db: AlertsDb = getDb(),
): Promise<boolean> {
  const rows = await db
    .delete(alertRules)
    .where(inProject(projectId, id))
    .returning({ id: alertRules.id });
  return rows.length > 0;
}

export const HISTORY_LIMIT = 50;

/** The newest state changes of a rule. */
export async function listAlertEvents(
  projectId: string,
  ruleId: string,
  db: AlertsDb = getDb(),
  limit: number = HISTORY_LIMIT,
) {
  return db
    .select({
      id: alertEvents.id,
      fromState: alertEvents.fromState,
      toState: alertEvents.toState,
      value: alertEvents.value,
      operator: alertEvents.operator,
      threshold: alertEvents.threshold,
      windowMinutes: alertEvents.windowMinutes,
      at: alertEvents.at,
      notice: alertEvents.notice,
      delivery: alertEvents.delivery,
      attempts: alertEvents.attempts,
      sentTo: alertEvents.sentTo,
      error: alertEvents.error,
    })
    .from(alertEvents)
    .innerJoin(alertRules, eq(alertRules.id, alertEvents.ruleId))
    .where(and(eq(alertRules.projectId, projectId), eq(alertEvents.ruleId, ruleId)))
    .orderBy(desc(alertEvents.at), desc(alertEvents.id))
    .limit(limit);
}

export type AlertEvent = Awaited<ReturnType<typeof listAlertEvents>>[number];

function inProject(projectId: string, id: string) {
  return and(eq(alertRules.projectId, projectId), eq(alertRules.id, id));
}
