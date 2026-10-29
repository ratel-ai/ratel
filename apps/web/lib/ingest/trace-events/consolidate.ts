import { and, eq, inArray, sql } from "drizzle-orm";
import { type NewOtelLog, otelLogs } from "@/lib/ingest/otlp/schema";
import { runtimeEventSources } from "@/lib/ingest/runtime-events/schema";
import { deterministicEventId, type ParsedTraceEvent } from "@/lib/ingest/trace-events/parse";
import {
  intentGraphRuntimeStatus,
  type NewIntentGraphRuntimeStatusRow,
  type NewTraceEvent,
  type NewTraceEventHit,
  toolUsageCounters,
  traceEventHits,
  traceEvents,
} from "@/lib/ingest/trace-events/schema";
import type { getDb } from "@/lib/platform/db/client";

export type TraceEventIngestDb = Pick<ReturnType<typeof getDb>, "select" | "insert"> &
  Partial<Pick<ReturnType<typeof getDb>, "delete" | "transaction">>;

export type ConsolidateTraceEventsOptions = {
  /**
   * Whether a source's facts era suppresses post-era OTLP derivations.
   * Exact-dupe protection by runtime event id applies regardless. Defaults to
   * true; only the integration tests turn it off.
   */
  factsEraSupersede?: boolean;
  /**
   * Keep the per-runtime ranking-status row and the graphs' live state from
   * `usage_ranking_status` events. Off, the events are stored like any other
   * and nothing else is written: the row and the live sync serve the
   * Cloud-built intent graph, so the route passes the build flag's value.
   */
  intentGraphRuntimeStatus?: boolean;
  /**
   * Recompute the graphs' live state after a runtime's ranking status changed. The intent graph
   * owns it; absent until that module lands, so only the status row is kept.
   */
  syncIntentGraphLive?: (
    projectId: string,
    tx: TraceTransaction | TraceEventIngestDb,
  ) => Promise<void>;
};

type TraceTransaction = Parameters<
  Parameters<NonNullable<TraceEventIngestDb["transaction"]>>[0]
>[0];

type InsertedFact = {
  event: ParsedTraceEvent;
  row: NewTraceEvent;
};

type ToolCounter = {
  sourceId: string;
  toolId: string;
  calls: number;
  errors: number;
  totalDurationMs: number;
  firstUsedAt: Date;
  lastUsedAt: Date;
};

const ERROR_TYPES: ReadonlySet<string> = new Set(["invoke_error"]);
const TOOL_COMPLETION_TYPES: ReadonlySet<string> = new Set(["invoke_end", "invoke_error"]);
const EXPERIMENT_EVENT_PREFIX = "experiment_";
const FACTS_ERA_CLOCK_SKEW = sql`interval '5 minutes'`;
const PARENT_INSERT_CHUNK_SIZE = 500;
const HIT_INSERT_CHUNK_SIZE = 500;
const EXPERIMENT_INSERT_CHUNK_SIZE = 500;
const EXPERIMENT_ATTRIBUTE_KEYS: Record<string, string> = {
  served_arm: "served.arm",
  served_outcome: "served.outcome",
  served_duration_ms: "served.duration_ms",
  served_hit_count: "served.hit_count",
  shadow_arm: "shadow.arm",
  shadow_outcome: "shadow.outcome",
  shadow_duration_ms: "shadow.duration_ms",
  shadow_hit_count: "shadow.hit_count",
  query: "query",
  result_ids: "result_ids",
  result_scores: "result_scores",
  attributed: "invocation.attributed",
  rank: "invocation.rank",
  age_ms: "invocation.age_ms",
  label: "outcome.label",
  score: "outcome.score",
};
const EXPERIMENT_AGREEMENT_ATTRIBUTE_KEYS: Record<string, string> = {
  top1: "top1",
  exactOrder: "exact_order",
  overlapCount: "overlap_count",
  jaccardAtK: "jaccard_at_k",
  k: "k",
};
const EXPERIMENT_EVENT_ATTRIBUTE_KEYS: Record<string, Record<string, string>> = {
  experiment_skip: {
    skipped_arm: "skip.arm",
    concurrency: "skip.concurrency",
    reason: "skip.reason",
  },
  experiment_fallback: {
    effective_arm: "fallback.effective_arm",
    reused_shadow: "fallback.reused_shadow",
  },
  experiment_drop: {
    reason: "drop.reason",
  },
  experiment_invocation: {
    effective_arm: "effective_arm",
    // The invoked tool's id and the caller's turn ordinal. The quality reads
    // probe `invocation.tool_id` to name the revealed target; without it an
    // attributed invocation only says where the served arm ranked something.
    tool_id: "invocation.tool_id",
    turn: "invocation.turn",
  },
};

/** Atomically persist runtime/OTLP ledger rows and direct-facts read models. */
export async function consolidateTraceEvents(
  projectId: string,
  events: ParsedTraceEvent[],
  db: TraceEventIngestDb,
  options: ConsolidateTraceEventsOptions = {},
): Promise<{ accepted: number }> {
  if (events.length === 0) return { accepted: 0 };

  const run = async (tx: TraceTransaction) => {
    const eligibleEvents = await withoutSupersededOtlpEvents(
      projectId,
      events,
      tx,
      options.factsEraSupersede ?? true,
    );
    if (eligibleEvents.length === 0) return { accepted: 0 };

    await deleteSupersededOtlpOverlaps(projectId, eligibleEvents, tx);

    const byId = new Map<string, InsertedFact>();
    for (const event of eligibleEvents) {
      const id = deterministicEventId(projectId, event.clientEventId);
      if (!byId.has(id)) {
        byId.set(id, {
          event,
          row: toTraceRow(id, projectId, event),
        });
      }
    }

    const insertedIds = await insertParents(
      [...byId.values()].map(({ row }) => row),
      tx,
    );
    const inserted = [...byId.values()].filter(({ row }) => insertedIds.has(row.id));
    const insertedFacts = inserted.filter(({ event }) => event.ingestSource === "runtime");

    await insertHits(projectId, inserted, tx);
    await upsertSources(projectId, insertedFacts, tx);
    await upsertToolCounters(projectId, insertedFacts, tx);
    await upsertExperimentLogs(projectId, insertedFacts, tx);
    if (
      options.intentGraphRuntimeStatus === true &&
      (await upsertRuntimeRankingStatus(projectId, insertedFacts, tx))
    ) {
      // A runtime starting or stopping to rank from a Cloud graph is what makes it live.
      await options.syncIntentGraphLive?.(projectId, tx);
    }

    return { accepted: insertedIds.size };
  };

  return db.transaction ? db.transaction(run) : run(db as TraceTransaction);
}

async function deleteSupersededOtlpOverlaps(
  projectId: string,
  events: ParsedTraceEvent[],
  db: TraceTransaction,
): Promise<void> {
  const eventIds = distinctStrings(
    events.filter((event) => event.ingestSource === "runtime").map((event) => event.eventId),
  );
  if (eventIds.length === 0 || !db.delete) return;
  await db
    .delete(traceEvents)
    .where(
      and(
        eq(traceEvents.projectId, projectId),
        eq(traceEvents.ingestSource, "otlp"),
        inArray(traceEvents.eventId, eventIds),
      ),
    );
}

/** `otlp_model_call` (`lib/otlp/derive-model-calls.ts`): Agent health's model round trips. */
const OTLP_MODEL_CALL_TYPE = "otlp_model_call";

async function withoutSupersededOtlpEvents(
  projectId: string,
  events: ParsedTraceEvent[],
  db: TraceTransaction,
  factsEraSupersede: boolean,
): Promise<ParsedTraceEvent[]> {
  const otlp = events.filter((event) => event.ingestSource === "otlp");
  if (otlp.length === 0) return events;

  const sourceIds = distinctStrings(otlp.map((event) => event.sourceId));
  const eventIds = distinctStrings(otlp.map((event) => event.eventId));
  const [sources, overlaps] = await Promise.all([
    sourceIds.length === 0 || !factsEraSupersede
      ? []
      : db
          .select({
            sourceId: runtimeEventSources.sourceId,
            factsStartedAt: runtimeEventSources.factsStartedAt,
          })
          .from(runtimeEventSources)
          .where(
            and(
              eq(runtimeEventSources.projectId, projectId),
              inArray(runtimeEventSources.sourceId, sourceIds),
            ),
          ),
    eventIds.length === 0
      ? []
      : db
          .select({ eventId: traceEvents.eventId })
          .from(traceEvents)
          .where(
            and(
              eq(traceEvents.projectId, projectId),
              eq(traceEvents.ingestSource, "runtime"),
              inArray(traceEvents.eventId, eventIds),
            ),
          ),
  ]);
  const factsStartedAt = new Map(sources.map((source) => [source.sourceId, source.factsStartedAt]));
  const directEventIds = new Set(overlaps.map(({ eventId }) => eventId));

  return events.filter((event) => {
    if (event.ingestSource !== "otlp") return true;
    if (event.eventId && directEventIds.has(event.eventId)) return false;
    // The SDK never publishes model round trips, so its facts era supersedes none.
    if (event.type === OTLP_MODEL_CALL_TYPE) return true;
    const boundary = event.sourceId ? factsStartedAt.get(event.sourceId) : undefined;
    return !boundary || event.occurredAt < boundary;
  });
}

async function insertParents(rows: NewTraceEvent[], db: TraceTransaction): Promise<Set<string>> {
  const insertedIds = new Set<string>();
  const legacyOrOtlp = rows.filter((row) => row.ingestSource !== "runtime");
  const runtime = rows.filter((row) => row.ingestSource === "runtime");
  for (let offset = 0; offset < legacyOrOtlp.length; offset += PARENT_INSERT_CHUNK_SIZE) {
    const inserted = await db
      .insert(traceEvents)
      .values(legacyOrOtlp.slice(offset, offset + PARENT_INSERT_CHUNK_SIZE))
      .onConflictDoNothing()
      .returning({ id: traceEvents.id });
    for (const { id } of inserted) insertedIds.add(id);
  }
  for (let offset = 0; offset < runtime.length; offset += PARENT_INSERT_CHUNK_SIZE) {
    const inserted = await db
      .insert(traceEvents)
      .values(runtime.slice(offset, offset + PARENT_INSERT_CHUNK_SIZE))
      .onConflictDoUpdate({
        target: traceEvents.id,
        set: runtimeParentUpdate(),
        setWhere: sql`${traceEvents.ingestSource} is distinct from 'runtime'`,
      })
      .returning({ id: traceEvents.id });
    for (const { id } of inserted) insertedIds.add(id);
  }
  return insertedIds;
}

function runtimeParentUpdate() {
  return {
    type: sql`excluded.type`,
    schemaVersion: sql`excluded.schema_version`,
    sessionId: sql`excluded.session_id`,
    occurredAt: sql`excluded.occurred_at`,
    receivedAt: sql`current_timestamp`,
    ingestSource: "runtime",
    clientEventId: sql`excluded.client_event_id`,
    eventId: sql`excluded.event_id`,
    sourceId: sql`excluded.source_id`,
    invocationId: sql`excluded.invocation_id`,
    traceId: sql`excluded.trace_id`,
    spanId: sql`excluded.span_id`,
    turnId: sql`excluded.turn_id`,
    toolId: sql`excluded.tool_id`,
    skillId: sql`excluded.skill_id`,
    query: sql`excluded.query`,
    origin: sql`excluded.origin`,
    tookMs: sql`excluded.took_ms`,
    errorMessage: sql`excluded.error_message`,
    topK: sql`excluded.top_k`,
    hitCount: sql`excluded.hit_count`,
    server: sql`excluded.server`,
    searchId: sql`excluded.search_id`,
    correlationId: sql`excluded.correlation_id`,
    catalogVersion: sql`excluded.catalog_version`,
    harness: sql`excluded.harness`,
    environment: sql`excluded.environment`,
    endUserId: sql`excluded.end_user_id`,
    inputTokens: sql`excluded.input_tokens`,
    outputTokens: sql`excluded.output_tokens`,
    costUsd: sql`excluded.cost_usd`,
    payload: sql`excluded.payload`,
  };
}

async function insertHits(
  projectId: string,
  inserted: InsertedFact[],
  db: TraceTransaction,
): Promise<void> {
  const rows: NewTraceEventHit[] = inserted.flatMap(({ event, row }) =>
    event.hits.map((hit) => ({
      traceEventId: row.id,
      projectId,
      endUserId: row.endUserId,
      rank: hit.rank,
      targetType: hit.targetType,
      targetId: hit.targetId,
      score: hit.score,
    })),
  );
  for (let offset = 0; offset < rows.length; offset += HIT_INSERT_CHUNK_SIZE) {
    await db
      .insert(traceEventHits)
      .values(rows.slice(offset, offset + HIT_INSERT_CHUNK_SIZE))
      .onConflictDoNothing();
  }
}

async function upsertSources(
  projectId: string,
  facts: InsertedFact[],
  db: TraceTransaction,
): Promise<void> {
  const earliestBySource = new Map<string, Date>();
  for (const { event } of facts) {
    if (!event.sourceId) continue;
    const prior = earliestBySource.get(event.sourceId);
    if (!prior || event.occurredAt < prior) {
      earliestBySource.set(event.sourceId, event.occurredAt);
    }
  }
  if (earliestBySource.size === 0) return;
  await db
    .insert(runtimeEventSources)
    .values(
      [...earliestBySource].map(([sourceId, factsStartedAt]) => ({
        projectId,
        sourceId,
        factsStartedAt: boundedFactTimestamp(factsStartedAt),
      })),
    )
    .onConflictDoUpdate({
      target: [runtimeEventSources.projectId, runtimeEventSources.sourceId],
      set: {
        factsStartedAt: sql`coalesce(${runtimeEventSources.factsStartedAt}, excluded.facts_started_at)`,
        lastSeenAt: sql`current_timestamp`,
      },
    });
}

async function upsertToolCounters(
  projectId: string,
  facts: InsertedFact[],
  db: TraceTransaction,
): Promise<void> {
  const counters = new Map<string, ToolCounter>();
  for (const { event } of facts) {
    if (!event.sourceId || !event.toolId || !TOOL_COMPLETION_TYPES.has(event.type)) {
      continue;
    }
    const key = `${event.sourceId}\u0000${event.toolId}`;
    const counter = counters.get(key) ?? newToolCounter(event);
    counter.calls += 1;
    counter.errors += ERROR_TYPES.has(event.type) ? 1 : 0;
    counter.totalDurationMs += event.tookMs ?? 0;
    if (event.occurredAt < counter.firstUsedAt) {
      counter.firstUsedAt = event.occurredAt;
    }
    if (event.occurredAt > counter.lastUsedAt) {
      counter.lastUsedAt = event.occurredAt;
    }
    counters.set(key, counter);
  }
  if (counters.size === 0) return;
  await db
    .insert(toolUsageCounters)
    .values(
      [...counters.values()].map((counter) => ({
        projectId,
        ...counter,
        firstUsedAt: boundedFactTimestamp(counter.firstUsedAt),
        lastUsedAt: boundedFactTimestamp(counter.lastUsedAt),
      })),
    )
    .onConflictDoUpdate({
      target: [toolUsageCounters.projectId, toolUsageCounters.sourceId, toolUsageCounters.toolId],
      set: {
        calls: sql`${toolUsageCounters.calls} + excluded.calls`,
        errors: sql`${toolUsageCounters.errors} + excluded.errors`,
        totalDurationMs: sql`${toolUsageCounters.totalDurationMs} + excluded.total_duration_ms`,
        firstUsedAt: sql`least(${toolUsageCounters.firstUsedAt}, excluded.first_used_at)`,
        lastUsedAt: sql`greatest(${toolUsageCounters.lastUsedAt}, excluded.last_used_at)`,
      },
    });
}

async function upsertExperimentLogs(
  projectId: string,
  facts: InsertedFact[],
  db: TraceTransaction,
): Promise<void> {
  const rows = facts
    .map(({ event }) => toExperimentLog(projectId, event))
    .filter((row): row is NewOtelLog => row !== null);
  for (let offset = 0; offset < rows.length; offset += EXPERIMENT_INSERT_CHUNK_SIZE) {
    // Merge, don't replace: the same deterministic id may already hold the
    // richer OTLP-exported log row (e.g. per-item ratel.experiment.* attrs the
    // calibration drill-down renders). Runtime wins the fields it projects;
    // keys and correlations it does not carry are preserved.
    await db
      .insert(otelLogs)
      .values(rows.slice(offset, offset + EXPERIMENT_INSERT_CHUNK_SIZE))
      .onConflictDoUpdate({
        target: otelLogs.id,
        set: {
          eventName: sql`excluded.event_name`,
          eventId: sql`excluded.event_id`,
          sourceId: sql`coalesce(excluded.source_id, ${otelLogs.sourceId})`,
          ingestSource: "runtime",
          occurredAt: sql`excluded.occurred_at`,
          traceId: sql`coalesce(excluded.trace_id, ${otelLogs.traceId})`,
          spanId: sql`coalesce(excluded.span_id, ${otelLogs.spanId})`,
          experimentName: sql`coalesce(excluded.experiment_name, ${otelLogs.experimentName})`,
          experimentArm: sql`coalesce(excluded.experiment_arm, ${otelLogs.experimentArm})`,
          experimentRole: sql`coalesce(excluded.experiment_role, ${otelLogs.experimentRole})`,
          experimentSelectionId: sql`coalesce(excluded.experiment_selection_id, ${otelLogs.experimentSelectionId})`,
          experimentAttrs: sql`${otelLogs.experimentAttrs} || excluded.experiment_attrs`,
          attributes: sql`${otelLogs.attributes} || excluded.attributes`,
        },
      });
  }
}

/**
 * Keep one current adaptive-ranking status row per runtime source from the
 * `usage_ranking_status` events in this batch. Latest by event time wins,
 * within the batch and against what is stored, so an older event that arrives
 * late never overwrites a newer state. Driven only by rows actually inserted,
 * so a replayed batch is a no-op here too.
 */
async function upsertRuntimeRankingStatus(
  projectId: string,
  facts: InsertedFact[],
  db: TraceTransaction,
): Promise<boolean> {
  const latest = new Map<string, NewIntentGraphRuntimeStatusRow>();
  for (const { event } of facts) {
    if (event.type !== "usage_ranking_status" || !event.sourceId) continue;
    const p = event.payload;
    const row: NewIntentGraphRuntimeStatusRow = {
      projectId,
      sourceId: event.sourceId,
      status: String(p.status),
      reason: String(p.reason),
      rev: typeof p.rev === "number" ? p.rev : null,
      graphKey: typeof p.graph_key === "string" ? p.graph_key : null,
      learn: p.learn !== false,
      model: typeof p.model === "string" ? p.model : null,
      observedAt: event.occurredAt,
    };
    // A runtime adopting a newer graph disables and re-enables within the same
    // millisecond: on a tie the later event in the batch is the current state.
    const prior = latest.get(row.sourceId);
    if (!prior || prior.observedAt <= row.observedAt) latest.set(row.sourceId, row);
  }
  if (latest.size === 0) return false;
  await db
    .insert(intentGraphRuntimeStatus)
    .values([...latest.values()])
    .onConflictDoUpdate({
      target: [intentGraphRuntimeStatus.projectId, intentGraphRuntimeStatus.sourceId],
      set: {
        status: sql`excluded.status`,
        reason: sql`excluded.reason`,
        rev: sql`excluded.rev`,
        // A disable report names no graph; keep the one the runtime stopped
        // ranking from, so the graph's live state can be released per graph.
        graphKey: sql`coalesce(excluded.graph_key, ${intentGraphRuntimeStatus.graphKey})`,
        learn: sql`excluded.learn`,
        model: sql`excluded.model`,
        observedAt: sql`excluded.observed_at`,
      },
      // On a tie the later ingest wins, as within a batch: the disable and
      // re-enable of a runtime adopting a newer graph share a millisecond and
      // may straddle a flush, and the enable must land. A replayed report
      // never reaches here: its event id was already stored, so it is not in
      // `facts`.
      setWhere: sql`${intentGraphRuntimeStatus.observedAt} <= excluded.observed_at`,
    });
  return true;
}

function toTraceRow(id: string, projectId: string, event: ParsedTraceEvent): NewTraceEvent {
  return {
    id,
    projectId,
    type: event.type,
    schemaVersion: event.schemaVersion,
    sessionId: event.sessionId,
    occurredAt: event.occurredAt,
    ingestSource: event.ingestSource,
    clientEventId: event.clientEventId,
    eventId: event.eventId,
    sourceId: event.sourceId,
    invocationId: event.invocationId,
    traceId: event.traceId,
    spanId: event.spanId,
    turnId: event.turnId,
    toolId: event.toolId,
    skillId: event.skillId,
    query: event.query,
    origin: event.origin,
    tookMs: event.tookMs,
    errorMessage: event.errorMessage,
    topK: event.topK,
    hitCount: event.hitCount,
    server: event.server,
    searchId: event.searchId,
    correlationId: event.correlationId,
    catalogVersion: event.catalogVersion,
    harness: event.harness,
    environment: event.environment,
    endUserId: event.endUserId,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    costUsd: event.costUsd != null ? event.costUsd.toString() : null,
    payload: event.payload,
  };
}

function toExperimentLog(projectId: string, event: ParsedTraceEvent): NewOtelLog | null {
  if (!event.type.startsWith(EXPERIMENT_EVENT_PREFIX) || !event.eventId) {
    return null;
  }
  return {
    id: deterministicEventId(projectId, event.eventId),
    projectId,
    occurredAt: event.occurredAt,
    eventName: `ratel.experiment.${event.type.slice(EXPERIMENT_EVENT_PREFIX.length).replaceAll("_", ".")}`,
    eventId: event.eventId,
    sourceId: event.sourceId,
    ingestSource: "runtime",
    traceId: event.traceId,
    spanId: event.spanId,
    severityNumber: 0,
    serviceName: event.sourceId,
    scopeName: "ratel.runtime-events",
    body: null,
    experimentName: payloadText(event.payload, "experiment_id", "experiment", "name"),
    experimentArm: payloadText(event.payload, "arm"),
    experimentRole: payloadText(event.payload, "role"),
    experimentSelectionId: payloadText(event.payload, "selection_id"),
    experimentAttrs: experimentAttributes(event.type, event.payload),
    attributes: { "ratel.event.id": event.eventId },
    attrsTruncated: false,
  };
}

function newToolCounter(event: ParsedTraceEvent): ToolCounter {
  return {
    sourceId: event.sourceId!,
    toolId: event.toolId!,
    calls: 0,
    errors: 0,
    totalDurationMs: 0,
    firstUsedAt: event.occurredAt,
    lastUsedAt: event.occurredAt,
  };
}

function boundedFactTimestamp(occurredAt: Date) {
  return sql<Date>`least(greatest(${occurredAt}, current_timestamp - ${FACTS_ERA_CLOCK_SKEW}), current_timestamp)`;
}

function experimentAttributes(
  eventType: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const attributes = Object.fromEntries(
    Object.entries(EXPERIMENT_ATTRIBUTE_KEYS)
      .filter(([field]) => payload[field] !== undefined)
      .map(([field, suffix]) => [`ratel.experiment.${suffix}`, payload[field]]),
  );
  const agreement = payload.agreement;
  if (agreement && typeof agreement === "object" && !Array.isArray(agreement)) {
    for (const [field, suffix] of Object.entries(EXPERIMENT_AGREEMENT_ATTRIBUTE_KEYS)) {
      const value = (agreement as Record<string, unknown>)[field];
      if (value !== undefined) {
        attributes[`ratel.experiment.agreement.${suffix}`] = value;
      }
    }
  }
  for (const [field, suffix] of Object.entries(EXPERIMENT_EVENT_ATTRIBUTE_KEYS[eventType] ?? {})) {
    const value = payload[field];
    if (value !== undefined) {
      attributes[`ratel.experiment.${suffix}`] = value;
    }
  }
  return attributes;
}

function payloadText(payload: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function distinctStrings(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => value !== null))];
}
