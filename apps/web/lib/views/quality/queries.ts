import { and, asc, eq, gte, inArray, isNotNull, lt, or } from "drizzle-orm";
import { otelLogs, otelSpans } from "@/lib/ingest/otlp/schema";
import { traceEvents } from "@/lib/ingest/trace-events/schema";
import { getDb } from "@/lib/platform/db/client";

/**
 * The two reads Quality v2 adds: which run a search happened in, and whether
 * that run's trace was kept. Everything else reuses the match-quality and
 * calibration queries. A link to a trace that was never stored is a link to a
 * 404, and a link to another search's trace is worse, so a search only gets
 * one when its own record carries a trace that has spans.
 *
 * Ids are not unique over time (`trace_events.search_id` comes from the SDK
 * and is reused across sessions), so both lookups are bounded by the window
 * the search was read from, ordered, and matched on the sighting's own time.
 */

type Db = Pick<ReturnType<typeof getDb>, "select" | "selectDistinct">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMPARISON_EVENT = "ratel.experiment.comparison";

/** One search as the page read it: its selection id and when it happened. */
export interface Sighting {
  selectionId: string;
  occurredAt: Date;
}

export interface TraceCandidate {
  /** Every id the record answers to (the SDK's search id and the event's own id). */
  keys: readonly (string | null)[];
  occurredAt: Date | null;
  traceId: string | null;
}

/**
 * Each sighting's trace, from candidate records: same key AND same instant.
 * A reused id from another moment never matches, so it can never lend its run.
 */
export function matchSightings(
  sightings: readonly Sighting[],
  candidates: readonly TraceCandidate[],
): Map<string, string> {
  const byKeyAndTime = new Map<string, string>();
  for (const candidate of candidates) {
    if (!candidate.traceId || !candidate.occurredAt) continue;
    for (const key of candidate.keys) {
      if (key) byKeyAndTime.set(`${key}\u0000${candidate.occurredAt.getTime()}`, candidate.traceId);
    }
  }
  const traces = new Map<string, string>();
  for (const sighting of sightings) {
    const traceId = byKeyAndTime.get(
      `${sighting.selectionId}\u0000${sighting.occurredAt.getTime()}`,
    );
    if (traceId) traces.set(sighting.selectionId, traceId);
  }
  return traces;
}

/** Trace ids for search-telemetry sightings, keyed by selection id. */
export async function searchTraceIds(
  projectId: string,
  sightings: readonly Sighting[],
  window: { since: Date; until: Date },
  db: Db = getDb(),
): Promise<Map<string, string>> {
  if (sightings.length === 0) return new Map();
  const ids = [...new Set(sightings.map((sighting) => sighting.selectionId))];
  const eventIds = ids.filter((id) => UUID.test(id));
  const rows = await db
    .select({
      id: traceEvents.id,
      searchId: traceEvents.searchId,
      traceId: traceEvents.traceId,
      occurredAt: traceEvents.occurredAt,
    })
    .from(traceEvents)
    .where(
      and(
        eq(traceEvents.projectId, projectId),
        eq(traceEvents.type, "search"),
        isNotNull(traceEvents.traceId),
        gte(traceEvents.occurredAt, window.since),
        lt(traceEvents.occurredAt, window.until),
        eventIds.length > 0
          ? or(inArray(traceEvents.searchId, ids), inArray(traceEvents.id, eventIds))
          : inArray(traceEvents.searchId, ids),
      ),
    )
    .orderBy(asc(traceEvents.occurredAt));
  return matchSightings(
    sightings,
    rows.map((row) => ({
      keys: [row.searchId, row.id],
      occurredAt: toDate(row.occurredAt),
      traceId: row.traceId,
    })),
  );
}

/** Trace ids for one experiment's sightings, from its comparison records. */
export async function experimentTraceIds(
  projectId: string,
  experimentName: string,
  sightings: readonly Sighting[],
  window: { since: Date; until: Date },
  db: Db = getDb(),
): Promise<Map<string, string>> {
  if (sightings.length === 0) return new Map();
  const ids = [...new Set(sightings.map((sighting) => sighting.selectionId))];
  const rows = await db
    .select({
      selectionId: otelLogs.experimentSelectionId,
      traceId: otelLogs.traceId,
      occurredAt: otelLogs.occurredAt,
    })
    .from(otelLogs)
    .where(
      and(
        eq(otelLogs.projectId, projectId),
        eq(otelLogs.eventName, COMPARISON_EVENT),
        eq(otelLogs.experimentName, experimentName),
        inArray(otelLogs.experimentSelectionId, ids),
        isNotNull(otelLogs.traceId),
        gte(otelLogs.occurredAt, window.since),
        lt(otelLogs.occurredAt, window.until),
      ),
    )
    .orderBy(asc(otelLogs.occurredAt));
  return matchSightings(
    sightings,
    rows.map((row) => ({
      keys: [row.selectionId],
      occurredAt: toDate(row.occurredAt),
      traceId: row.traceId,
    })),
  );
}

/** The subset of trace ids that have at least one stored span. */
export async function tracesWithSpans(
  projectId: string,
  traceIds: readonly string[],
  db: Db = getDb(),
): Promise<Set<string>> {
  const unique = [...new Set(traceIds)];
  if (unique.length === 0) return new Set();
  const rows = await db
    .selectDistinct({ traceId: otelSpans.traceId })
    .from(otelSpans)
    .where(and(eq(otelSpans.projectId, projectId), inArray(otelSpans.traceId, unique)));
  return new Set(rows.map((row) => row.traceId));
}

function toDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}
