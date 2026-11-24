import { randomUUID } from "node:crypto";
import { and, asc, count, eq } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import { openSecret, sealSecret } from "@/lib/platform/secret-box";
import { alertDestinations, alertRuleDestinations } from "@/lib/views/alerts/schema";
import { parseSlackWebhook } from "@/lib/views/alerts/slack-url";
import type { AlertsDb } from "@/lib/views/alerts/store";
import type { AlertDestination } from "@/lib/views/alerts/types";

export const MAX_DESTINATIONS = 20;
const LAST = 4;

/** What a page may show. Never the sealed URL. */
const SHOWN = {
  id: alertDestinations.id,
  name: alertDestinations.name,
  lastFour: alertDestinations.lastFour,
};
const SEALED = { ...SHOWN, sealedUrl: alertDestinations.sealedUrl };

export async function listDestinations(
  projectId: string,
  db: AlertsDb = getDb(),
): Promise<AlertDestination[]> {
  return db
    .select(SHOWN)
    .from(alertDestinations)
    .where(eq(alertDestinations.projectId, projectId))
    .orderBy(asc(alertDestinations.createdAt), asc(alertDestinations.id));
}

export async function countDestinations(
  projectId: string,
  db: AlertsDb = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(alertDestinations)
    .where(eq(alertDestinations.projectId, projectId));
  return row.n;
}

/** The URL is sealed for this row before it is written. */
export async function createDestination(
  input: { projectId: string; name: string; url: URL; actor: string; key?: string },
  db: AlertsDb = getDb(),
): Promise<string> {
  const id = randomUUID();
  await db.insert(alertDestinations).values({
    id,
    projectId: input.projectId,
    name: input.name,
    sealedUrl: sealSecret(input.url.href, bindingOf(id), input.key),
    lastFour: input.url.href.slice(-LAST),
    createdBy: input.actor,
  });
  return id;
}

export async function deleteDestination(
  projectId: string,
  id: string,
  db: AlertsDb = getDb(),
): Promise<boolean> {
  const rows = await db
    .delete(alertDestinations)
    .where(and(eq(alertDestinations.projectId, projectId), eq(alertDestinations.id, id)))
    .returning({ id: alertDestinations.id });
  return rows.length > 0;
}

/** A destination as a sender reads it. Its URL stays sealed until `webhookOf`. */
export interface SealedDestination extends AlertDestination {
  sealedUrl: string;
}

export async function sealedDestination(
  projectId: string,
  id: string,
  db: AlertsDb = getDb(),
): Promise<SealedDestination | null> {
  const [row] = await db
    .select(SEALED)
    .from(alertDestinations)
    .where(and(eq(alertDestinations.projectId, projectId), eq(alertDestinations.id, id)));
  return row ?? null;
}

export async function sealedDestinationsOfRule(
  ruleId: string,
  db: AlertsDb = getDb(),
): Promise<SealedDestination[]> {
  return db
    .select(SEALED)
    .from(alertDestinations)
    .innerJoin(alertRuleDestinations, eq(alertRuleDestinations.destinationId, alertDestinations.id))
    .where(eq(alertRuleDestinations.ruleId, ruleId))
    .orderBy(asc(alertDestinations.createdAt), asc(alertDestinations.id));
}

/** The address to post to, its host checked again; null when it is not allowed any more. */
export function webhookOf({ id, sealedUrl }: SealedDestination, key?: string): URL | null {
  return parseSlackWebhook(openSecret(sealedUrl, bindingOf(id), key));
}

function bindingOf(id: string): string {
  return `alert_destinations:${id}`;
}
