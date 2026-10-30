import { and, asc, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import {
  type ConsolidateTraceEventsOptions,
  consolidateTraceEvents,
  type TraceEventIngestDb,
} from "@/lib/ingest/trace-events/consolidate";
import { deterministicEventId, type ParsedTraceEvent } from "@/lib/ingest/trace-events/parse";
import {
  type NewTraceEventReject,
  traceEventRejects,
  traceEvents,
} from "@/lib/ingest/trace-events/schema";
import { getDb } from "@/lib/platform/db/client";

/** The trace event reads and writes (owned fragment of the upstream queries hub, ADR-0030). */

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

const SEARCH_TYPES = ["search", "skill_search", "gateway_search"] as const;
const traceEventTime = sql`coalesce(${traceEvents.occurredAt}, ${traceEvents.receivedAt})`;

export async function listTopSearchQueries(
  projectId: string,
  opts: { since?: Date; limit?: number; endUserId?: string } = {},
  db: Pick<TraceDb, "select"> = getDb(),
): Promise<Array<{ query: string; searches: number }>> {
  const since = opts.since ?? new Date(Date.now() - 7 * 86_400_000);
  const rows = await db
    .select({ query: traceEvents.query, searches: sql<number>`count(*)::int` })
    .from(traceEvents)
    .where(
      and(
        eq(traceEvents.projectId, projectId),
        inArray(traceEvents.type, [...SEARCH_TYPES]),
        isNotNull(traceEvents.query),
        gte(traceEventTime, since),
        opts.endUserId ? eq(traceEvents.endUserId, opts.endUserId) : undefined,
      ),
    )
    .groupBy(traceEvents.query)
    .orderBy(desc(sql`count(*)`), asc(traceEvents.query))
    .limit(opts.limit ?? 50);
  return rows.map((r) => ({ query: r.query as string, searches: r.searches }));
}

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
