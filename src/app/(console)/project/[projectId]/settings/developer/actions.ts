"use server";

import { findProjectScope } from "@/lib/console/scope/project-scope";
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
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { getSessionContext } from "@/lib/platform/session";

/**
 * The payload of one SDK event, for the Panel that just opened on Settings >
 * Developer. A read, not a mutation: scoped to a project of an organization the reader belongs to, bounded by a statement timeout, and a failed read
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
      // A project of any organization the reader belongs to; the user id only proves there is a session.
      findProject: async (id) => (await findProjectScope(id))?.project ?? null,
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
