import { and, asc, eq, inArray } from "drizzle-orm";
import type { CloudEvent } from "@/lib/ingest/cloud-schema";
import { events, otelSpans } from "@/lib/ingest/otlp/schema";
import { traceTurns } from "@/lib/ledger/schema";
import { loadTurnTraceIds } from "@/lib/views/session-chat/turn-traces";
import type { ReplayDb } from "@/lib/views/session-replay/load";
import {
  buildReplaySource,
  type ReplaySourceResult,
  type SourceSpan,
  type SourceTurn,
} from "./session-source";

/**
 * Reads a recorded session as a replay source (RC-1109): the session's closed
 * turns in time order (the turns the session page shows), the spans of each
 * turn's traces and, only with the content opt-in on, the model-call payloads
 * that hold the user messages.
 *
 * PRIVACY: the messages and tool results are the project's own content; they
 * go only to a member of the project, and nothing here logs them.
 */

export interface SessionSourceQuery {
  projectId: string;
  sessionId: string;
  /** The project's content opt-in (`contentOptIn`). Off: no payload is read. */
  readContent: boolean;
}

export async function readSessionReplaySource(
  db: ReplayDb,
  query: SessionSourceQuery,
): Promise<ReplaySourceResult> {
  const { projectId, sessionId, readContent } = query;
  const turns = await db
    .select({ id: traceTurns.id })
    .from(traceTurns)
    .where(
      and(
        eq(traceTurns.projectId, projectId),
        eq(traceTurns.sessionId, sessionId),
        eq(traceTurns.status, "closed"),
      ),
    )
    .orderBy(asc(traceTurns.startedAt), asc(traceTurns.id));
  const tracesByTurn = await loadTurnTraceIds(
    projectId,
    turns.map((turn) => turn.id),
    db,
  );
  const traceIds = [...new Set([...tracesByTurn.values()].flat())];
  const spans = traceIds.length ? await readSpans(db, projectId, traceIds) : [];
  const payloads =
    readContent && traceIds.length
      ? await readPayloads(db, projectId, traceIds)
      : new Map<string, CloudEvent | null>();

  const sourceTurns: SourceTurn[] = turns
    .map((turn) => tracesByTurn.get(turn.id) ?? [])
    .filter((ids) => ids.length > 0)
    .map((ids) => {
      const inTurn = new Set(ids);
      return { traceIds: ids, spans: spans.filter((span) => inTurn.has(span.traceId)), payloads };
    });
  return buildReplaySource(sessionId, sourceTurns, { readContent });
}

async function readSpans(
  db: ReplayDb,
  projectId: string,
  traceIds: readonly string[],
): Promise<(SourceSpan & { traceId: string })[]> {
  const rows = await db
    .select({
      traceId: otelSpans.traceId,
      spanId: otelSpans.spanId,
      parentSpanId: otelSpans.parentSpanId,
      startedAt: otelSpans.startedAt,
      operation: otelSpans.operationName,
      statusCode: otelSpans.statusCode,
      attributes: otelSpans.attributes,
    })
    .from(otelSpans)
    .where(and(eq(otelSpans.projectId, projectId), inArray(otelSpans.traceId, [...traceIds])));
  return rows.map((row) => ({
    ...row,
    attributes: (row.attributes ?? {}) as Record<string, unknown>,
  }));
}

/** Model-call payloads of the traces, by span id. */
async function readPayloads(
  db: ReplayDb,
  projectId: string,
  traceIds: readonly string[],
): Promise<Map<string, CloudEvent | null>> {
  const rows = await db
    .select({ spanId: events.spanId, payload: events.payload })
    .from(events)
    .where(and(eq(events.projectId, projectId), inArray(events.traceId, [...traceIds])));
  return new Map(
    rows.flatMap((row) =>
      row.spanId ? [[row.spanId, row.payload as CloudEvent | null] as const] : [],
    ),
  );
}
