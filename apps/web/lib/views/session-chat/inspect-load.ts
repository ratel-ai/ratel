import { and, eq, inArray } from "drizzle-orm";
import { events } from "@/lib/ingest/otlp/schema";
import { traceEvents } from "@/lib/ingest/trace-events/schema";
import { getDb } from "@/lib/platform/db/client";
import type { ReplayDb } from "@/lib/views/session-replay/load";
import { type CallView, parseCallPayload } from "./inspect";

/**
 * The stored text behind one inspector view (RC-284): a few model calls'
 * payloads (the call, the one before it, the one after a tool step) and a
 * search's query. Only with the project's content opt-in on: off, nothing is
 * read and the inspector shows numbers and the split only. Every read is
 * scoped to the project, as in `lib/session-replay/load.ts`.
 */

export interface StepContentRequest {
  /** `events.id` of model calls of the session. */
  eventIds: readonly string[];
  /** `trace_events.id` of a search step, for its query. */
  searchEventId?: string | null;
}

export interface StoredCall {
  /** The payload as stored (the raw request view). */
  raw: unknown;
  view: CallView;
}

export interface StepContent {
  calls: Record<string, StoredCall>;
  query: string | null;
}

/** At most this many payloads per request: a call, the one before and the one after. */
export const MAX_STEP_CALLS = 3;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The content, or null with the opt-in off (then no payload is read). */
export async function loadStepContent(
  projectId: string,
  request: StepContentRequest,
  { readContent }: { readContent: boolean },
  db: ReplayDb = getDb(),
): Promise<StepContent | null> {
  if (!readContent) return null;
  const eventIds = [...new Set(request.eventIds)]
    .filter((id) => UUID.test(id))
    .slice(0, MAX_STEP_CALLS);
  const calls: Record<string, StoredCall> = {};
  if (eventIds.length > 0) {
    const rows = await db
      .select({ id: events.id, payload: events.payload })
      .from(events)
      .where(and(eq(events.projectId, projectId), inArray(events.id, eventIds)));
    for (const row of rows)
      calls[row.id] = { raw: row.payload, view: parseCallPayload(row.payload) };
  }
  let query: string | null = null;
  if (request.searchEventId && UUID.test(request.searchEventId)) {
    const [row] = await db
      .select({ query: traceEvents.query })
      .from(traceEvents)
      .where(and(eq(traceEvents.projectId, projectId), eq(traceEvents.id, request.searchEventId)))
      .limit(1);
    query = row?.query ?? null;
  }
  return { calls, query };
}
