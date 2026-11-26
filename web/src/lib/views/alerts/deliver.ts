import { and, eq, notInArray, sql } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import { featureEnabled } from "@/lib/platform/experimental-features";
import { getLogger } from "@/lib/platform/logger";
import { notOnHold } from "@/lib/platform/org-hold/sql";
import { projects } from "@/lib/platform/projects/schema";
import type { AlertNotice, AlertNotifier, NoticeOutcome } from "@/lib/views/alerts/notifier";
import { storedQuery } from "@/lib/views/alerts/parse-rule";
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
  /** Still pending after `EXPIRE_MS`: given up. */
  expired: number;
  failures: { projectId: string; ruleId: string; attempts: number }[];
}

/** The first try and 3 more. */
export const MAX_ATTEMPTS = 4;
/** A send that did not report back for this long was lost with its process. */
const CLAIM_MS = 120_000;
/** A message that waited this long says nothing of now any more, for example while its flag was off. */
export const EXPIRE_MS = 24 * 3_600_000;
const EXPIRED = "The message expired unsent.";
const BATCH = 100;
const TIME_BUDGET_MS = 20_000;

const logger = getLogger("alerts/deliver");

/**
 * Send the pending messages, oldest first. A message is claimed, with its attempt counted, before
 * it is sent: no transaction is open during a send and two ticks never send the same one. A failed
 * one stays pending for the next tick, up to `MAX_ATTEMPTS`. The messages of a project whose flag is
 * off stay pending and are left out of this tick's next reads, so they never hold up the other
 * projects. A message pending for `EXPIRE_MS` is given up.
 */
export async function deliverAlerts(
  notifier: AlertNotifier,
  options: DeliverOptions = {},
  db: Db = getDb(),
): Promise<DeliveryResult> {
  const now = options.now ?? (() => new Date());
  const on =
    options.flagOn ?? ((projectId: string) => featureEnabled("customMonitoring", { projectId }));
  const startedAt = Date.now();
  const overBudget = () => Date.now() - startedAt >= (options.timeBudgetMs ?? TIME_BUDGET_MS);
  const result: DeliveryResult = {
    sent: 0,
    retrying: 0,
    expired: await expire(db, now()),
    failures: [],
  };
  const off = new Set<string>();
  // Each message once per tick: a failed one is claimable again at once.
  const seen = new Set<string>();
  while (seen.size < BATCH && !overBudget()) {
    const batch = await pendingEvents(db, now(), { off: [...off], seen: [...seen] });
    if (batch.length === 0) break;
    for (const { notice } of batch) {
      if (seen.size >= BATCH || overBudget()) break;
      if (off.has(notice.projectId)) continue;
      if (!(await on(notice.projectId))) {
        off.add(notice.projectId);
        logger.info({ project_id: notice.projectId }, "alert messages held: the flag is off");
        continue;
      }
      seen.add(notice.eventId);
      const attempts = await claim(db, notice.eventId, now());
      if (attempts === null) continue;
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
  }
  return result;
}

/** The oldest claimable messages, without those of the projects in `off` and the ones `seen`. */
async function pendingEvents(
  db: Db,
  now: Date,
  { off, seen }: { off: readonly string[]; seen: readonly string[] },
): Promise<{ notice: AlertNotice }[]> {
  const rows = await db
    .select({ event: alertEvents, rule: alertRules, projectName: projects.name })
    .from(alertEvents)
    .innerJoin(alertRules, eq(alertRules.id, alertEvents.ruleId))
    .innerJoin(projects, eq(projects.id, alertRules.projectId))
    .where(
      and(
        claimable(now),
        notOnHold(alertRules.projectId),
        off.length > 0 ? notInArray(alertRules.projectId, [...off]) : undefined,
        seen.length > 0 ? notInArray(alertEvents.id, [...seen]) : undefined,
      ),
    )
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
            query: storedQuery(rule.query).query,
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

/** Gives up the messages pending for `EXPIRE_MS`, whatever their project's flag. */
async function expire(db: Db, now: Date): Promise<number> {
  const before = new Date(now.getTime() - EXPIRE_MS);
  const rows = await db
    .update(alertEvents)
    .set({ delivery: "failed", claimedAt: null, error: EXPIRED })
    .where(sql`${claimable(now)} and ${alertEvents.at} < ${before.toISOString()}::timestamptz`)
    .returning({ ruleId: alertEvents.ruleId });
  if (rows.length > 0)
    logger.warn({ expired: rows.length, before: before.toISOString() }, "alert messages expired");
  return rows.length;
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
