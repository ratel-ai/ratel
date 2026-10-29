import {
  type ConsolidateTraceEventsOptions,
  consolidateTraceEvents,
  type TraceEventIngestDb,
} from "@/lib/ingest/trace-events/consolidate";
import { deterministicEventId, type ParsedTraceEvent } from "@/lib/ingest/trace-events/parse";
import { type NewTraceEventReject, traceEventRejects } from "@/lib/ingest/trace-events/schema";
import { getDb } from "@/lib/platform/db/client";

/** The trace event writes (owned fragment of the upstream queries hub, ADR-0030). */

export type TraceDb = Pick<ReturnType<typeof getDb>, "select" | "insert">;
export type TraceEventRejectInput = Omit<NewTraceEventReject, "id" | "projectId" | "receivedAt"> & {
  /**
   * Stable content hash of the raw rejected item. Keys the reject id when the
   * item carries no event_id, so distinct anonymous rejects with the same
   * reason don't collapse to one row while an exact retry still dedupes.
   * Never stored: id derivation only.
   */
  payloadHash?: string | null;
};

export async function insertTraceEvents(
  projectId: string,
  events: ParsedTraceEvent[],
  db: TraceEventIngestDb = getDb(),
  options: ConsolidateTraceEventsOptions = {},
): Promise<{ accepted: number }> {
  return consolidateTraceEvents(projectId, events, db, options);
}

export async function insertTraceEventRejects(
  projectId: string,
  rejects: TraceEventRejectInput[],
  db: TraceDb = getDb(),
): Promise<void> {
  if (rejects.length === 0) return;
  await db
    .insert(traceEventRejects)
    .values(
      rejects.map(({ payloadHash, ...reject }) => ({
        ...reject,
        id: deterministicEventId(
          projectId,
          JSON.stringify([reject.eventId ?? payloadHash ?? null, reject.reason]),
        ),
        projectId,
      })),
    )
    .onConflictDoNothing();
}
