import { randomUUID } from "node:crypto";
import { and, asc, count, eq } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import { lockProjectScope } from "@/lib/platform/db/project-lock";
import { projects } from "@/lib/platform/projects/schema";
import { openSecret, sealSecret } from "@/lib/platform/secret-box";
import {
  type AlertDestinationRow,
  alertDestinations,
  alertRuleDestinations,
} from "@/lib/views/alerts/schema";
import { parseSlackWebhook } from "@/lib/views/alerts/slack-url";
import type { AlertsDb } from "@/lib/views/alerts/store";
import type { AlertDestination } from "@/lib/views/alerts/types";

export const MAX_DESTINATIONS = 20;

/** Why a destination was not created. */
export type DestinationRefusal = "limit" | "taken";
const LAST = 4;

const ROW = {
  id: alertDestinations.id,
  name: alertDestinations.name,
  kind: alertDestinations.kind,
  lastFour: alertDestinations.lastFour,
  teamId: alertDestinations.teamId,
  channelId: alertDestinations.channelId,
  accessError: alertDestinations.accessError,
};
const SEALED = {
  ...ROW,
  sealedUrl: alertDestinations.sealedUrl,
  organizationId: projects.organizationId,
};

/** What a page may show. Never the sealed URL. */
export async function listDestinations(
  projectId: string,
  db: AlertsDb = getDb(),
): Promise<AlertDestination[]> {
  const rows = await db
    .select(ROW)
    .from(alertDestinations)
    .where(eq(alertDestinations.projectId, projectId))
    .orderBy(asc(alertDestinations.createdAt), asc(alertDestinations.id));
  return rows.map(shown);
}

export async function countDestinations(
  projectId: string,
  db: Pick<AlertsDb, "select"> = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(alertDestinations)
    .where(eq(alertDestinations.projectId, projectId));
  return row.n;
}

/**
 * The URL is sealed for this row before it is written. "limit" when the project has
 * `MAX_DESTINATIONS` already: the count and the insert are one transaction under the project's lock.
 */
export async function createDestination(
  input: { projectId: string; name: string; url: URL; actor: string; key?: string },
  db: AlertsDb = getDb(),
): Promise<string | "limit"> {
  const id = randomUUID();
  return withinLimit(db, input.projectId, async (tx) => {
    await tx.insert(alertDestinations).values({
      id,
      projectId: input.projectId,
      name: input.name,
      kind: "webhook",
      sealedUrl: sealSecret(input.url.href, bindingOf(id), input.key),
      lastFour: input.url.href.slice(-LAST),
      createdBy: input.actor,
    });
    return id;
  });
}

/** "taken" when the project has the channel already, "limit" as for `createDestination`. */
export async function createChannelDestination(
  input: {
    projectId: string;
    name: string;
    teamId: string;
    channelId: string;
    accessError: string | null;
    actor: string;
  },
  db: AlertsDb = getDb(),
): Promise<string | DestinationRefusal> {
  const { actor, ...values } = input;
  return withinLimit(db, input.projectId, async (tx) => {
    const [row] = await tx
      .insert(alertDestinations)
      .values({ ...values, id: randomUUID(), kind: "slack_channel", createdBy: actor })
      .onConflictDoNothing()
      .returning({ id: alertDestinations.id });
    return row?.id ?? "taken";
  });
}

/** `create` under the project's lock, while the project has fewer than `MAX_DESTINATIONS`. */
async function withinLimit<T>(
  db: AlertsDb,
  projectId: string,
  create: (tx: Pick<AlertsDb, "insert">) => Promise<T>,
): Promise<T | "limit"> {
  return db.transaction(async (tx) => {
    await lockProjectScope(tx, "alert_destinations", projectId);
    if ((await countDestinations(projectId, tx)) >= MAX_DESTINATIONS) return "limit";
    return create(tx);
  });
}

/** Keeps why the app could not post to a channel; null: it could. */
export async function recordAccess(
  id: string,
  accessError: string | null,
  db: AlertsDb = getDb(),
): Promise<void> {
  await db.update(alertDestinations).set({ accessError }).where(eq(alertDestinations.id, id));
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

/** A destination as a sender reads it. A webhook's URL stays sealed until `webhookOf`. */
export type SealedDestination = SealedWebhook | SealedChannel;
export type SealedChannel = Extract<AlertDestination, { kind: "slack_channel" }> & {
  organizationId: string;
};
export type SealedWebhook = Extract<AlertDestination, { kind: "webhook" }> & { sealedUrl: string };

export async function sealedDestination(
  projectId: string,
  id: string,
  db: AlertsDb = getDb(),
): Promise<SealedDestination | null> {
  const [row] = await db
    .select(SEALED)
    .from(alertDestinations)
    .innerJoin(projects, eq(projects.id, alertDestinations.projectId))
    .where(and(eq(alertDestinations.projectId, projectId), eq(alertDestinations.id, id)));
  return row ? sealed(row) : null;
}

export async function sealedDestinationsOfRule(
  ruleId: string,
  db: AlertsDb = getDb(),
): Promise<SealedDestination[]> {
  const rows = await db
    .select(SEALED)
    .from(alertDestinations)
    .innerJoin(projects, eq(projects.id, alertDestinations.projectId))
    .innerJoin(alertRuleDestinations, eq(alertRuleDestinations.destinationId, alertDestinations.id))
    .where(eq(alertRuleDestinations.ruleId, ruleId))
    .orderBy(asc(alertDestinations.createdAt), asc(alertDestinations.id));
  return rows.map(sealed);
}

/** The address to post to, its host checked again; null when it is not allowed any more. */
export function webhookOf(
  { id, sealedUrl }: Pick<SealedWebhook, "id" | "sealedUrl">,
  key?: string,
): URL | null {
  return parseSlackWebhook(openSecret(sealedUrl, bindingOf(id), key));
}

type Row = Pick<AlertDestinationRow, keyof typeof ROW>;

/** The table's check holds a kind's own columns not null. */
function shown({
  id,
  name,
  kind,
  lastFour,
  teamId,
  channelId,
  accessError,
}: Row): AlertDestination {
  return kind === "webhook"
    ? { id, name, kind, lastFour: lastFour ?? "" }
    : { id, name, kind, teamId: teamId ?? "", channelId: channelId ?? "", accessError };
}

function sealed(
  row: Row & { sealedUrl: string | null; organizationId: string },
): SealedDestination {
  const destination = shown(row);
  return destination.kind === "webhook"
    ? { ...destination, sealedUrl: row.sealedUrl ?? "" }
    : { ...destination, organizationId: row.organizationId };
}

function bindingOf(id: string): string {
  return `alert_destinations:${id}`;
}
