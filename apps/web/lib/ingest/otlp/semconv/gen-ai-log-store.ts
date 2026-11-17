import { and, eq, inArray } from "drizzle-orm";
import type { EventWithMetric } from "@/lib/ingest/otlp/queries";
import { eventMetrics, events, type OtelSpan, otelLogs, otelSpans } from "@/lib/ingest/otlp/schema";
import { getDb } from "@/lib/platform/db/client";
import { GEN_AI_LOG_EVENT_NAMES } from "../log-rows";
import type { SpanKey, StoredGenAiLog } from "./gen-ai-logs";

/**
 * The storage half of the `gen_ai` log join (flag `cloud-otlp-semconv-aliases`):
 * read the stored log records and spans of a batch, and restate a stored model
 * call. Every read is scoped to one project and uses `*_project_trace_idx`.
 */
export interface GenAiLogStore {
  findLogs(projectId: string, keys: SpanKey[]): Promise<StoredGenAiLog[]>;
  findSpans(projectId: string, traceIds: string[]): Promise<OtelSpan[]>;
  /** Restate the stored calls of `rows` (matched by dedupe hash); never inserts one. Returns the count restated. */
  restateCalls(projectId: string, rows: EventWithMetric[]): Promise<number>;
}

type Db = Pick<ReturnType<typeof getDb>, "select" | "transaction">;

export function createGenAiLogStore(db: () => Db = getDb): GenAiLogStore {
  return {
    findLogs: (projectId, keys) => findGenAiLogs(projectId, keys, db()),
    findSpans: (projectId, traceIds) => findOtelSpans(projectId, traceIds, db()),
    restateCalls: (projectId, rows) => restateCalls(projectId, rows, db()),
  };
}

async function findGenAiLogs(
  projectId: string,
  keys: SpanKey[],
  db: Db,
): Promise<StoredGenAiLog[]> {
  if (keys.length === 0) return [];
  const wanted = new Set(keys.map((key) => `${key.traceId}:${key.spanId}`));
  const rows = await db
    .select({
      traceId: otelLogs.traceId,
      spanId: otelLogs.spanId,
      eventName: otelLogs.eventName,
      occurredAt: otelLogs.occurredAt,
      attributes: otelLogs.attributes,
      body: otelLogs.body,
    })
    .from(otelLogs)
    .where(
      and(
        eq(otelLogs.projectId, projectId),
        inArray(otelLogs.traceId, [...new Set(keys.map((key) => key.traceId))]),
        inArray(otelLogs.spanId, [...new Set(keys.map((key) => key.spanId))]),
        inArray(otelLogs.eventName, [...GEN_AI_LOG_EVENT_NAMES]),
      ),
    );
  return rows.flatMap((row) =>
    row.traceId && row.spanId && wanted.has(`${row.traceId}:${row.spanId}`)
      ? [{ ...row, traceId: row.traceId, spanId: row.spanId }]
      : [],
  );
}

async function findOtelSpans(projectId: string, traceIds: string[], db: Db): Promise<OtelSpan[]> {
  if (traceIds.length === 0) return [];
  return db
    .select()
    .from(otelSpans)
    .where(and(eq(otelSpans.projectId, projectId), inArray(otelSpans.traceId, traceIds)));
}

async function restateCalls(projectId: string, rows: EventWithMetric[], db: Db): Promise<number> {
  if (rows.length === 0) return 0;
  return db.transaction(async (tx) => {
    let restated = 0;
    for (const { event, metric } of rows) {
      if (!event.dedupeHash) continue;
      const [stored] = await tx
        .update(events)
        .set({
          provider: event.provider,
          model: event.model,
          stream: event.stream,
          finishReason: event.finishReason,
          latencyMs: event.latencyMs,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          cachedTokens: event.cachedTokens,
          reasoningTokens: event.reasoningTokens,
          costUsd: event.costUsd,
          payload: event.payload,
          categorizerVersion: event.categorizerVersion,
        })
        .where(and(eq(events.projectId, projectId), eq(events.dedupeHash, event.dedupeHash)))
        .returning({ id: events.id });
      if (!stored) continue;
      await tx
        .insert(eventMetrics)
        .values({ ...metric, eventId: stored.id, projectId })
        .onConflictDoUpdate({ target: eventMetrics.eventId, set: metric });
      restated += 1;
    }
    return restated;
  });
}
