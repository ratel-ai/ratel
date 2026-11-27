import { and, eq, isNotNull, isNull, or } from "drizzle-orm";
import type { SlackAppCredentials } from "@/lib/contracts/slack-app";
import { getDb } from "@/lib/platform/db/client";
import { openSecret, sealSecret } from "@/lib/platform/secret-box";
import { slackApps, slackConnections } from "@/lib/views/slack/schema";
import type { SlackConnection } from "@/lib/views/slack/types";

export type SlackDb = Pick<ReturnType<typeof getDb>, "select" | "insert" | "update" | "delete">;

export async function savedClientId(
  organizationId: string,
  db: SlackDb = getDb(),
): Promise<string | null> {
  const [row] = await db
    .select({ clientId: slackApps.clientId })
    .from(slackApps)
    .where(eq(slackApps.organizationId, organizationId));
  return row?.clientId ?? null;
}

/** The saved app with its secret opened: for the exchange only. */
export async function readSlackApp(
  organizationId: string,
  db: SlackDb = getDb(),
  key?: string,
): Promise<SlackAppCredentials | null> {
  const [row] = await db
    .select()
    .from(slackApps)
    .where(eq(slackApps.organizationId, organizationId));
  if (!row) return null;
  return {
    clientId: row.clientId,
    clientSecret: openSecret(row.sealedSecret, appBinding(organizationId), key),
  };
}

export async function saveSlackApp(
  input: SlackAppCredentials & { organizationId: string; actor: string; key?: string },
  db: SlackDb = getDb(),
): Promise<void> {
  const values = {
    clientId: input.clientId,
    sealedSecret: sealSecret(input.clientSecret, appBinding(input.organizationId), input.key),
    updatedBy: input.actor,
    updatedAt: new Date(),
  };
  await db
    .insert(slackApps)
    .values({ organizationId: input.organizationId, ...values })
    .onConflictDoUpdate({ target: slackApps.organizationId, set: values });
}

/** The workspace stays connected: its token does not need the app's secret. */
export async function deleteSlackApp(organizationId: string, db: SlackDb = getDb()): Promise<void> {
  await db.delete(slackApps).where(eq(slackApps.organizationId, organizationId));
}

export async function getSlackConnection(
  organizationId: string,
  db: SlackDb = getDb(),
  key?: string,
): Promise<SlackConnection | null> {
  const connection = await sealedSlackConnection(organizationId, db);
  if (!connection) return null;
  const { teamId, teamName, lost } = connection;
  return { teamId, teamName, lost: lost || !opens(connection, key) };
}

/** A connection as a sender reads it. Its token stays sealed until `botTokenOf`. */
export interface SealedSlackConnection extends SlackConnection {
  organizationId: string;
  sealedToken: string;
}

export async function sealedSlackConnection(
  organizationId: string,
  db: SlackDb = getDb(),
): Promise<SealedSlackConnection | null> {
  const [row] = await db
    .select()
    .from(slackConnections)
    .where(eq(slackConnections.organizationId, organizationId));
  if (!row) return null;
  const { teamId, teamName, sealedToken, lostAt } = row;
  return { organizationId, teamId, teamName, sealedToken, lost: lostAt !== null };
}

/** Throws `SecretBoxError` when the token cannot be opened. */
export function botTokenOf(
  { organizationId, sealedToken }: Pick<SealedSlackConnection, "organizationId" | "sealedToken">,
  key?: string,
): string {
  return openSecret(sealedToken, connectionBinding(organizationId), key);
}

/** `taken`: the organization has a live connection with another token; `same`: with this one. */
export type SaveOutcome = "saved" | "taken" | "same";

/** One workspace per organization: a lost connection is replaced, a live one never. */
export async function saveSlackConnection(
  input: {
    organizationId: string;
    teamId: string;
    teamName: string;
    token: string;
    actor: string;
    key?: string;
  },
  db: SlackDb = getDb(),
): Promise<SaveOutcome> {
  const { organizationId, token, key } = input;
  const before = await sealedSlackConnection(organizationId, db);
  // One that this key cannot open is lost too, though no column says so.
  const unopened = before && !opens(before, key) ? before.sealedToken : null;
  const values = {
    teamId: input.teamId,
    teamName: input.teamName,
    sealedToken: sealSecret(token, connectionBinding(organizationId), key),
    lostAt: null,
    connectedBy: input.actor,
    connectedAt: new Date(),
  };
  const rows = await db
    .insert(slackConnections)
    .values({ organizationId, ...values })
    .onConflictDoUpdate({
      target: slackConnections.organizationId,
      set: values,
      setWhere: or(
        isNotNull(slackConnections.lostAt),
        unopened === null ? undefined : eq(slackConnections.sealedToken, unopened),
      ),
    })
    .returning({ organizationId: slackConnections.organizationId });
  if (rows.length > 0) return "saved";
  const live = await sealedSlackConnection(organizationId, db);
  return live && opens(live, key) && botTokenOf(live, key) === token ? "same" : "taken";
}

export async function markSlackLost(
  { organizationId, sealedToken }: Pick<SealedSlackConnection, "organizationId" | "sealedToken">,
  db: SlackDb = getDb(),
): Promise<void> {
  await db
    .update(slackConnections)
    .set({ lostAt: new Date() })
    .where(
      and(
        eq(slackConnections.organizationId, organizationId),
        // A connection made while the send was under way has another token.
        eq(slackConnections.sealedToken, sealedToken),
        isNull(slackConnections.lostAt),
      ),
    );
}

export async function deleteSlackConnection(
  organizationId: string,
  db: SlackDb = getDb(),
): Promise<boolean> {
  const rows = await db
    .delete(slackConnections)
    .where(eq(slackConnections.organizationId, organizationId))
    .returning({ id: slackConnections.organizationId });
  return rows.length > 0;
}

function opens(connection: SealedSlackConnection, key?: string): boolean {
  try {
    botTokenOf(connection, key);
    return true;
  } catch {
    return false;
  }
}

function appBinding(organizationId: string): string {
  return `slack_apps:${organizationId}`;
}

function connectionBinding(organizationId: string): string {
  return `slack_connections:${organizationId}`;
}
