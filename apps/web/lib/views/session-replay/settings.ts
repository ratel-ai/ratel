import { and, eq, inArray } from "drizzle-orm";
import { events } from "@/lib/ingest/otlp/schema";
import { getDb } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import {
  defaultOrganizationFlagDeps,
  type OrganizationFlagDeps,
} from "@/lib/views/session-replay/gate";
import { sessionReplaySettings } from "@/lib/views/session-replay/schema";
import { sessionReplayEnabledForActor } from "./gate";

/**
 * The per-project content opt-in (RC-177). On, the session page shows the
 * message text of the model calls that kept it, and a What-if run may replay
 * the model on it. Off (the default), both stay text-free. Only an admin of
 * the project's organization changes it, and only with `cloud-session-replay` on.
 */

export type ContentOptInState = { ok: true; readContent: boolean } | { ok: false; error: string };

/** One model call's text, cut to what the page shows. */
export interface StepText {
  system: string | null;
  messages: { role: string; text: string }[];
  /** Earlier messages were left out. */
  omitted: number;
}

export interface ContentOptInDeps {
  db?: SettingsDb;
  flagDeps?: OrganizationFlagDeps;
  /** The signed-in person, or null. */
  getActor: () => Promise<{ userId: string; externalId: string } | null>;
  /** The person's role in the project's organization, or null when they are not a member. */
  findRole: (projectId: string, userId: string) => Promise<string | null>;
  /** An admin support session may look but not change settings. */
  isRestricted?: () => Promise<boolean>;
  track?: (event: { externalId: string; projectId: string; readContent: boolean }) => Promise<void>;
}

type SettingsDb = Pick<ReturnType<typeof getDb>, "select" | "insert">;

const MAX_MESSAGES = 6;
const MAX_CHARS = 600;
const ID_CHUNK = 500;
const logger = getLogger("session-replay/settings");

export const CONTENT_OPT_IN_ERRORS = {
  signed_out: "Sign in to change this setting.",
  not_found: "No project you belong to has that ID.",
  flag_off: "Session replay is off for this organization.",
  not_admin: "Only organization admins can change content reading.",
  restricted: "A support session cannot change settings.",
} as const;

/** Turn content reading on or off for a project. Admin-only. */
export async function setContentOptIn(
  projectId: string,
  readContent: boolean,
  deps: ContentOptInDeps,
): Promise<ContentOptInState> {
  const actor = await deps.getActor();
  if (!actor) return refuse("signed_out", projectId);
  const role = await deps.findRole(projectId, actor.userId);
  if (role === null) return refuse("not_found", projectId);
  const db = deps.db ?? getDb();
  if (
    !(await sessionReplayEnabledForActor(
      projectId,
      actor.externalId,
      db,
      deps.flagDeps ?? defaultOrganizationFlagDeps,
    ))
  )
    return refuse("flag_off", projectId);
  if (role !== "admin") return refuse("not_admin", projectId);
  if (await deps.isRestricted?.()) return refuse("restricted", projectId);
  await db
    .insert(sessionReplaySettings)
    .values({ projectId, readContent, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: sessionReplaySettings.projectId,
      set: { readContent, updatedAt: new Date() },
    });
  logger.info(
    { project_id: projectId, read_content: readContent, outcome: "saved" },
    "content_opt_in_set",
  );
  await deps.track?.({ externalId: actor.externalId, projectId, readContent });
  return { ok: true, readContent };
}

/**
 * The text of the given model calls, by event id. Call it only when the
 * project's opt-in is on: it is the one place session replay reads text.
 */
export async function loadStepTexts(
  projectId: string,
  eventIds: readonly string[],
  db: Pick<ReturnType<typeof getDb>, "select"> = getDb(),
): Promise<Map<string, StepText>> {
  const out = new Map<string, StepText>();
  for (let i = 0; i < eventIds.length; i += ID_CHUNK) {
    const rows = await db
      .select({ id: events.id, payload: events.payload })
      .from(events)
      .where(
        and(eq(events.projectId, projectId), inArray(events.id, eventIds.slice(i, i + ID_CHUNK))),
      );
    for (const row of rows) {
      const text = payloadText(row.payload);
      if (text) out.set(row.id, text);
    }
  }
  return out;
}

/** A call payload's system prompt and its last messages with text, each cut short. Null when it holds no text. */
export function payloadText(payload: unknown): StepText | null {
  if (!payload || typeof payload !== "object") return null;
  const { system, messages } = payload as { system?: unknown; messages?: unknown };
  const withText = (Array.isArray(messages) ? messages : [])
    .map((message) => ({
      role: typeof message?.role === "string" ? message.role : "unknown",
      text: messageText(message?.content),
    }))
    .filter((message) => message.text !== "");
  const kept = withText
    .slice(-MAX_MESSAGES)
    .map((message) => ({ ...message, text: cut(message.text) }));
  const systemText = typeof system === "string" && system !== "" ? cut(system) : null;
  if (!systemText && kept.length === 0) return null;
  return { system: systemText, messages: kept, omitted: withText.length - kept.length };
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        part?.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

function cut(text: string): string {
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}…` : text;
}

function refuse(code: keyof typeof CONTENT_OPT_IN_ERRORS, projectId: string): ContentOptInState {
  logger.info({ project_id: projectId, outcome: code }, "content_opt_in_set");
  return { ok: false, error: CONTENT_OPT_IN_ERRORS[code] };
}
