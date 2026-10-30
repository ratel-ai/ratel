import { type SdkEventPayload, toSdkEventPayload } from "@/lib/console/settings/sdk-events";
import type { RuntimeEventRow } from "@/lib/ingest/runtime-events/queries";

/**
 * Reading one SDK event's payload when its Panel opens, split from the
 * `"use server"` wrapper so it tests without Next, Clerk or a database. The
 * list ships without payloads; this is the one place a payload is read for
 * the browser, scoped to a project the reader belongs to.
 */

export type SdkEventPayloadState =
  | { ok: true; payload: SdkEventPayload }
  | { ok: false; error: string };

/** A read that failed (logged and reported by the caller) rather than found nothing. */
export const PAYLOAD_READ_FAILED = "failed";

export interface SdkEventPayloadDeps {
  isDbConfigured(): boolean;
  /** The signed-in user's id, or null without a session. */
  getUserId(): Promise<string | null>;
  /** The project when the user belongs to its organization, else null. */
  findProject(projectId: string, userId: string): Promise<{ id: string } | null>;
  readEvent(
    projectId: string,
    identifier: string,
  ): Promise<RuntimeEventRow | null | typeof PAYLOAD_READ_FAILED>;
}

/** Event ids are SDK strings (or row UUIDs), stored up to 512 characters. */
const MAX_IDENTIFIER = 512;

export async function readSdkEventPayload(
  input: { projectId: unknown; identifier: unknown },
  deps: SdkEventPayloadDeps,
): Promise<SdkEventPayloadState> {
  const { projectId, identifier } = input;
  if (
    typeof projectId !== "string" ||
    !projectId ||
    typeof identifier !== "string" ||
    !identifier
  ) {
    return { ok: false, error: "That event can't be found." };
  }
  if (identifier.length > MAX_IDENTIFIER) return { ok: false, error: "That event can't be found." };
  if (!deps.isDbConfigured()) return { ok: false, error: "Database not connected." };

  const userId = await deps.getUserId();
  if (!userId) return { ok: false, error: "Your session has expired. Sign in again." };
  const project = await deps.findProject(projectId, userId);
  if (!project) return { ok: false, error: "Project not found." };

  const row = await deps.readEvent(project.id, identifier);
  if (row === PAYLOAD_READ_FAILED)
    return { ok: false, error: "Couldn't load the payload. Try again in a moment." };
  if (!row) return { ok: false, error: "This event is no longer stored." };
  return { ok: true, payload: toSdkEventPayload(row) };
}
