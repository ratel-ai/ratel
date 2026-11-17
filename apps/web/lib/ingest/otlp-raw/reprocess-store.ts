import { and, eq, inArray, or } from "drizzle-orm";
import { insertEventsWithMetrics } from "@/lib/ingest/otlp/queries";
import { eventMetrics, events } from "@/lib/ingest/otlp/schema";
import type { getDb } from "@/lib/platform/db/client";
import type { ReprocessPlan, StoredEvent, StoredEventKeys } from "./reprocess";

/**
 * The Postgres side of an OTLP raw reprocess (`./reprocess`): look stored
 * events up by the keys of a rebuilt batch, and write one batch's plan in one
 * transaction, so a failed batch leaves its rows as they were.
 */

export type ReprocessDb = Pick<
  ReturnType<typeof getDb>,
  "select" | "insert" | "update" | "transaction"
>;

export async function findStoredEvents(
  db: Pick<ReturnType<typeof getDb>, "select">,
  projectId: string,
  { dedupeHashes, traceIds }: StoredEventKeys,
): Promise<StoredEvent[]> {
  if (dedupeHashes.length === 0 && traceIds.length === 0) return [];
  const rows = await db
    .select({
      id: events.id,
      dedupeHash: events.dedupeHash,
      traceId: events.traceId,
      spanId: events.spanId,
      provider: events.provider,
      model: events.model,
      stream: events.stream,
      finishReason: events.finishReason,
      latencyMs: events.latencyMs,
      inputTokens: events.inputTokens,
      outputTokens: events.outputTokens,
      cachedTokens: events.cachedTokens,
      reasoningTokens: events.reasoningTokens,
      costUsd: events.costUsd,
      payload: events.payload,
      categorizerVersion: events.categorizerVersion,
      metricId: eventMetrics.id,
      metric: {
        tokensByCategory: eventMetrics.tokensByCategory,
        splits: eventMetrics.splits,
        toolsByName: eventMetrics.toolsByName,
        toolsTotalCount: eventMetrics.toolsTotalCount,
        toolsUsedCount: eventMetrics.toolsUsedCount,
        inputTokens: eventMetrics.inputTokens,
        outputTokens: eventMetrics.outputTokens,
        costUsd: eventMetrics.costUsd,
        latencyMs: eventMetrics.latencyMs,
        categorizerVersion: eventMetrics.categorizerVersion,
      },
    })
    .from(events)
    .leftJoin(eventMetrics, eq(eventMetrics.eventId, events.id))
    .where(
      and(
        eq(events.projectId, projectId),
        or(
          dedupeHashes.length > 0 ? inArray(events.dedupeHash, dedupeHashes) : undefined,
          traceIds.length > 0 ? inArray(events.traceId, traceIds) : undefined,
        ),
      ),
    );
  return rows.map(({ id, dedupeHash, traceId, spanId, metricId, metric, ...event }) => ({
    id,
    dedupeHash,
    traceId,
    spanId,
    event,
    metric: metricId ? metric : null,
  }));
}

export async function applyReprocessPlan(
  db: ReprocessDb,
  projectId: string,
  plan: ReprocessPlan,
): Promise<void> {
  await db.transaction(async (tx) => {
    for (const update of plan.updates) {
      await tx
        .update(events)
        .set(update.event)
        .where(and(eq(events.id, update.eventId), eq(events.projectId, projectId)));
      const { eventTime: _keep, ...metric } = update.metric;
      await tx
        .insert(eventMetrics)
        .values({ ...update.metric, eventId: update.eventId, projectId })
        .onConflictDoUpdate({ target: eventMetrics.eventId, set: metric });
    }
    if (plan.inserts.length > 0) await insertEventsWithMetrics(projectId, plan.inserts, tx);
  });
}
