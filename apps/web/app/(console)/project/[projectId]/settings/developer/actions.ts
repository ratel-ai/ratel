"use server";

import { findProject } from "@/lib/console/navigation";
import {
  PAYLOAD_READ_FAILED,
  readSdkEventPayload,
  type SdkEventPayloadState,
} from "@/lib/console/settings/sdk-event-payload";
import { getRuntimeEvent } from "@/lib/ingest/runtime-events/queries";
import { isDbConfigured } from "@/lib/platform/db/client";
import {
  supplementaryReadTimeoutMs,
  withStatementTimeout,
} from "@/lib/platform/db/statement-timeout";
import { listProjectsForOrganization } from "@/lib/platform/projects/queries";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { getSessionContext } from "@/lib/platform/session";

/**
 * The payload of one SDK event, for the Panel that just opened on Settings >
 * Developer. A read, not a mutation: scoped to a project of the session organization, bounded by a statement timeout, and a failed read
 * is logged and reported before the Panel says so.
 */
export async function readSdkEventPayloadAction(
  projectId: string,
  identifier: string,
): Promise<SdkEventPayloadState> {
  return readSdkEventPayload(
    { projectId, identifier },
    {
      isDbConfigured,
      getUserId: async () => (await getSessionContext())?.user.id ?? null,
      // The session organization's projects; the user id only proves there is a session.
      findProject: async (id) => {
        const session = await getSessionContext();
        if (!session) return null;
        return findProject(await listProjectsForOrganization(session.organization.id), id) ?? null;
      },
      readEvent: (id, eventIdentifier) =>
        loadOrFallback<Awaited<ReturnType<typeof getRuntimeEvent>> | typeof PAYLOAD_READ_FAILED>({
          operation: "sdk_event_payload",
          distinctId: `project:${id}`,
          fallback: PAYLOAD_READ_FAILED,
          load: () =>
            withStatementTimeout((db) => getRuntimeEvent(id, eventIdentifier, db), {
              operation: "sdk_event_payload",
              timeoutMs: supplementaryReadTimeoutMs(),
            }),
        }),
    },
  );
}
