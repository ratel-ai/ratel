import { and, asc, desc, eq, gte, inArray, isNotNull, notExists, sql } from "drizzle-orm";
import {
  type ConsolidateTraceEventsOptions,
  consolidateTraceEvents,
  type TraceEventIngestDb,
} from "@/lib/ingest/trace-events/consolidate";
import { deterministicEventId, type ParsedTraceEvent } from "@/lib/ingest/trace-events/parse";
import {
  type NewTraceEventReject,
  traceEventHits,
  traceEventRejects,
  traceEvents,
} from "@/lib/ingest/trace-events/schema";
import { getDb } from "@/lib/platform/db/client";

/**
 * The trace event reads and writes (owned fragment of the upstream queries hub, ADR-0030): the
 * ingest path, the top search queries, and the joins the MCP improvement tools read (skills
 * searched but never invoked, the erroring tools, the queries that surfaced a skill).
 */

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
const ERROR_TYPES = ["invoke_error", "gateway_error", "upstream_error"] as const;
const traceEventTime = sql`coalesce(${traceEvents.occurredAt}, ${traceEvents.receivedAt})`;

/** Skills that search surfaced and the agent never invoked, most surfaced first. */
export async function listSkillsSearchedButNeverInvoked(
  projectId: string,
  opts: { endUserId?: string } = {},
  db: TraceDb = getDb(),
): Promise<Array<{ skillId: string; searchAppearances: number }>> {
  const invoked = db
    .select({ one: sql`1` })
    .from(traceEvents)
    .where(
      and(
        eq(traceEvents.projectId, projectId),
        eq(traceEvents.type, "skill_invoke"),
        eq(traceEvents.skillId, traceEventHits.targetId),
        opts.endUserId ? eq(traceEvents.endUserId, opts.endUserId) : undefined,
      ),
    );

  return db
    .select({
      skillId: traceEventHits.targetId,
      searchAppearances: sql<number>`count(*)::int`,
    })
    .from(traceEventHits)
    .where(
      and(
        eq(traceEventHits.projectId, projectId),
        eq(traceEventHits.targetType, "skill"),
        opts.endUserId ? eq(traceEventHits.endUserId, opts.endUserId) : undefined,
        notExists(invoked),
      ),
    )
    .groupBy(traceEventHits.targetId)
    .orderBy(desc(sql`count(*)`), asc(traceEventHits.targetId));
}

/** The tools with the most errors of any kind (invoke, gateway, upstream) since `since`. */
export async function listTopErroringTools(
  projectId: string,
  opts: { since?: Date; limit?: number; endUserId?: string } = {},
  db: TraceDb = getDb(),
): Promise<Array<{ toolId: string; errors: number }>> {
  const rows = await db
    .select({ toolId: traceEvents.toolId, errors: sql<number>`count(*)::int` })
    .from(traceEvents)
    .where(
      and(
        eq(traceEvents.projectId, projectId),
        inArray(traceEvents.type, [...ERROR_TYPES]),
        isNotNull(traceEvents.toolId),
        opts.since ? gte(traceEventTime, opts.since) : undefined,
        opts.endUserId ? eq(traceEvents.endUserId, opts.endUserId) : undefined,
      ),
    )
    .groupBy(traceEvents.toolId)
    .orderBy(desc(sql`count(*)`), asc(traceEvents.toolId))
    .limit(opts.limit ?? 20);
  // toolId is guaranteed non-null by the isNotNull filter.
  return rows.map((r) => ({ toolId: r.toolId as string, errors: r.errors }));
}

/** The search queries that surfaced one skill, most frequent first. */
export async function listSearchQueriesForSkillHit(
  projectId: string,
  skillId: string,
  limit = 8,
  opts: { endUserId?: string } = {},
  db: TraceDb = getDb(),
): Promise<string[]> {
  const rows = await db
    .select({ query: traceEvents.query, appearances: sql<number>`count(*)::int` })
    .from(traceEventHits)
    .innerJoin(traceEvents, eq(traceEventHits.traceEventId, traceEvents.id))
    .where(
      and(
        eq(traceEventHits.projectId, projectId),
        eq(traceEventHits.targetType, "skill"),
        eq(traceEventHits.targetId, skillId),
        isNotNull(traceEvents.query),
        opts.endUserId ? eq(traceEventHits.endUserId, opts.endUserId) : undefined,
      ),
    )
    .groupBy(traceEvents.query)
    .orderBy(desc(sql`count(*)`), asc(traceEvents.query))
    .limit(limit);
  return rows.map((r) => r.query as string);
}

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
