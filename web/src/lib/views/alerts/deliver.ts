import { eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import { featureEnabled } from "@/lib/platform/experimental-features";
import { getLogger } from "@/lib/platform/logger";
import { projects } from "@/lib/platform/projects/schema";
import type { AlertNotice, AlertNotifier, NoticeOutcome } from "@/lib/views/alerts/notifier";
import { alertEvents, alertRules } from "@/lib/views/alerts/schema";

type Db = ReturnType<typeof getDb>;

export interface DeliverOptions {
  now?: () => Date;
  flagOn?: (projectId: string) => Promise<boolean>;
  timeBudgetMs?: number;
}

export interface DeliveryResult {
  sent: number;
  /** Tried again on the next tick. */
  retrying: number;
  failures: { projectId: string; ruleId: string; attempts: number }[];
}

/** The first try and 3 more. */
export const MAX_ATTEMPTS = 4;
/** A send that did not report back for this long was lost with its process. */
const CLAIM_MS = 120_000;
const BATCH = 100;
const TIME_BUDGET_MS = 20_000;

const logger = getLogger("alerts/deliver");

/**
 * Send the pending messages, oldest first. A message is claimed, with its attempt counted, before
 * it is sent: no transaction is open during a send and two ticks never send the same one. A failed
 * one stays pending for the next tick, up to `MAX_ATTEMPTS`.
 */
export async function deliverAlerts(
  notifier: AlertNotifier,
  options: DeliverOptions = {},
  db: Db = getDb(),
): Promise<DeliveryResult> {
  const now = options.now ?? (() => new Date());
  const on = options.flagOn ?? ((projectId: string) => featureEnabled("alerts", { projectId }));
  const startedAt = Date.now();
  const result: DeliveryResult = { sent: 0, retrying: 0, failures: [] };
  for (const pending of await pendingEvents(db, now())) {
    if (Date.now() - startedAt >= (options.timeBudgetMs ?? TIME_BUDGET_MS)) break;
    if (!(await on(pending.notice.projectId))) continue;
    const attempts = await claim(db, pending.notice.eventId, now());
    if (attempts === null) continue;
    const { notice } = pending;
    const outcome = await attempt(notifier, notice, attempts);
    const delivery =
      outcome.error === null ? "sent" : attempts >= MAX_ATTEMPTS ? "failed" : "pending";
    await db
      .update(alertEvents)
      .set({ delivery, claimedAt: null, sentTo: outcome.sentTo, error: outcome.error })
      .where(eq(alertEvents.id, notice.eventId));
    if (delivery === "sent") result.sent += 1;
    else if (delivery === "pending") result.retrying += 1;
    else result.failures.push({ projectId: notice.projectId, ruleId: notice.ruleId, attempts });
  }
  return result;
}

async function pendingEvents(db: Db, now: Date): Promise<{ notice: AlertNotice }[]> {
  const rows = await db
    .select({ event: alertEvents, rule: alertRules, projectName: projects.name })
    .from(alertEvents)
    .innerJoin(alertRules, eq(alertRules.id, alertEvents.ruleId))
    .innerJoin(projects, eq(projects.id, alertRules.projectId))
    .where(claimable(now))
    .orderBy(alertEvents.at, alertEvents.id)
    .limit(BATCH);
  return rows.flatMap(({ event, rule, projectName }) =>
    event.notice
      ? {
          notice: {
            eventId: event.id,
            kind: event.notice,
            ruleId: rule.id,
            ruleName: rule.name,
            projectId: rule.projectId,
            projectName,
            query: rule.query,
            operator: event.operator,
            threshold: event.threshold,
            windowMinutes: event.windowMinutes,
            value: event.value,
            at: event.at,
            sentTo: event.sentTo,
          },
        }
      : [],
  );
}

/** The attempt's number, or null when another tick has the message. */
async function claim(db: Db, eventId: string, now: Date): Promise<number | null> {
  const [row] = await db
    .update(alertEvents)
    .set({ claimedAt: now, attempts: sql`${alertEvents.attempts} + 1` })
    .where(sql`${alertEvents.id} = ${eventId} and ${claimable(now)}`)
    .returning({ attempts: alertEvents.attempts });
  return row?.attempts ?? null;
}

async function attempt(
  notifier: AlertNotifier,
  notice: AlertNotice,
  attempts: number,
): Promise<NoticeOutcome> {
  try {
    return await notifier.send(notice);
  } catch (err) {
    // The type only: a message can repeat what was sent, or where to.
    const error = err instanceof Error ? err.name : "unknown";
    logger.error({ error, rule_id: notice.ruleId, attempts }, "alert message failed");
    return { sentTo: [...notice.sentTo], error: "The message could not be sent." };
  }
}

function claimable(now: Date) {
  const lost = new Date(now.getTime() - CLAIM_MS).toISOString();
  return sql`${alertEvents.delivery} = 'pending' and (${alertEvents.claimedAt} is null or ${alertEvents.claimedAt} < ${lost}::timestamptz)`;
}
