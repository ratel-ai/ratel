import { and, asc, desc, eq, gte, lt, or, sql } from "drizzle-orm";
import { runtimeEventSources } from "@/lib/ingest/runtime-events/schema";
import { traceEventRejects, traceEvents } from "@/lib/ingest/trace-events/schema";
import { getDb } from "@/lib/platform/db/client";

export type RuntimeEventsDb = Pick<ReturnType<typeof getDb>, "select">;
export type RuntimeSourceStatus = "active" | "stale" | "dormant" | "unknown";

export interface RuntimeEventFilters {
  type?: string;
  sourceId?: string;
  since?: Date;
  until?: Date;
  now?: Date;
  limit?: number;
}

export interface RuntimeEventRow {
  id: string;
  eventId: string | null;
  type: string;
  sourceId: string | null;
  sourceStatus: RuntimeSourceStatus;
  sourceLastSeenAt: Date | null;
  occurredAt: Date | null;
  receivedAt: Date;
  invocationId: string | null;
  traceId: string | null;
  spanId: string | null;
  toolId: string | null;
  skillId: string | null;
  query: string | null;
  origin: string | null;
  tookMs: number | null;
  errorMessage: string | null;
  topK: number | null;
  hitCount: number | null;
  server: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: string | null;
  payload: Record<string, unknown>;
}

export interface RuntimeEventRejectRow {
  id: string;
  eventId: string | null;
  type: string | null;
  reason: string;
  sizeBytes: number;
  sourceId: string | null;
  receivedAt: Date;
}

/** One source+reason bucket of SDK-reported `events_dropped` markers. */
export interface RuntimeEventClientDropGroup {
  sourceId: string | null;
  reason: string | null;
  droppedCount: number;
  windowCount: number;
  lastDropAt: Date;
}

export interface RuntimeEventFacets {
  types: string[];
  sources: Array<{
    sourceId: string;
    status: Exclude<RuntimeSourceStatus, "unknown">;
    lastSeenAt: Date;
  }>;
}

const DAY_MS = 86_400_000;
/** Rows a list read returns unless asked for fewer; pages that show a full list say so. */
export const RUNTIME_EVENTS_PAGE_SIZE = 100;
const DEFAULT_LIMIT = RUNTIME_EVENTS_PAGE_SIZE;
const MAX_LIMIT = 500;
const MAX_FACET_SOURCES = 500;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const eventTime = sql<Date>`coalesce(${traceEvents.occurredAt}, ${traceEvents.receivedAt})`;

export async function listRuntimeEvents(
  projectId: string,
  filters: RuntimeEventFilters = {},
  db: RuntimeEventsDb = getDb(),
): Promise<RuntimeEventRow[]> {
  const now = filters.now ?? new Date();
  const dormantCutoff = new Date(now.getTime() - 30 * DAY_MS);
  const status = sourceStatus(now);
  const rows = await db
    .select({
      id: traceEvents.id,
      eventId: traceEvents.eventId,
      type: traceEvents.type,
      sourceId: traceEvents.sourceId,
      sourceStatus: status,
      sourceLastSeenAt: runtimeEventSources.lastSeenAt,
      occurredAt: traceEvents.occurredAt,
      receivedAt: traceEvents.receivedAt,
      invocationId: traceEvents.invocationId,
      traceId: traceEvents.traceId,
      spanId: traceEvents.spanId,
      toolId: traceEvents.toolId,
      skillId: traceEvents.skillId,
      query: traceEvents.query,
      origin: traceEvents.origin,
      tookMs: traceEvents.tookMs,
      errorMessage: traceEvents.errorMessage,
      topK: traceEvents.topK,
      hitCount: traceEvents.hitCount,
      server: traceEvents.server,
      inputTokens: traceEvents.inputTokens,
      outputTokens: traceEvents.outputTokens,
      costUsd: traceEvents.costUsd,
      payload: traceEvents.payload,
    })
    .from(traceEvents)
    .leftJoin(
      runtimeEventSources,
      and(
        eq(runtimeEventSources.projectId, traceEvents.projectId),
        eq(runtimeEventSources.sourceId, traceEvents.sourceId),
      ),
    )
    .where(
      and(
        eq(traceEvents.projectId, projectId),
        eq(traceEvents.ingestSource, "runtime"),
        filters.type ? eq(traceEvents.type, filters.type) : undefined,
        filters.sourceId ? eq(traceEvents.sourceId, filters.sourceId) : undefined,
        filters.since ? gte(eventTime, filters.since) : undefined,
        filters.until ? lt(eventTime, filters.until) : undefined,
        filters.sourceId
          ? undefined
          : or(
              gte(runtimeEventSources.lastSeenAt, dormantCutoff),
              sql`${runtimeEventSources.lastSeenAt} is null`,
            ),
      ),
    )
    .orderBy(desc(eventTime), desc(traceEvents.id))
    .limit(pageSize(filters.limit));
  return rows as RuntimeEventRow[];
}

/**
 * How many runtime events arrived in a window: the "received" number on
 * Settings > Developer, counting every row the list can show (the SDK's own
 * `events_dropped` reports included, since they arrived too). Uncapped,
 * unlike the 100-row list.
 */
export async function countRuntimeEvents(
  projectId: string,
  filters: Omit<RuntimeEventFilters, "now" | "limit" | "type"> = {},
  db: RuntimeEventsDb = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(traceEvents)
    .where(
      and(
        eq(traceEvents.projectId, projectId),
        eq(traceEvents.ingestSource, "runtime"),
        filters.sourceId ? eq(traceEvents.sourceId, filters.sourceId) : undefined,
        filters.since ? gte(eventTime, filters.since) : undefined,
        filters.until ? lt(eventTime, filters.until) : undefined,
      ),
    );
  return row?.count ?? 0;
}

export async function getRuntimeEvent(
  projectId: string,
  identifier: string,
  db: RuntimeEventsDb = getDb(),
): Promise<RuntimeEventRow | null> {
  const status = sourceStatus(new Date());
  const [row] = await db
    .select({
      id: traceEvents.id,
      eventId: traceEvents.eventId,
      type: traceEvents.type,
      sourceId: traceEvents.sourceId,
      sourceStatus: status,
      sourceLastSeenAt: runtimeEventSources.lastSeenAt,
      occurredAt: traceEvents.occurredAt,
      receivedAt: traceEvents.receivedAt,
      invocationId: traceEvents.invocationId,
      traceId: traceEvents.traceId,
      spanId: traceEvents.spanId,
      toolId: traceEvents.toolId,
      skillId: traceEvents.skillId,
      query: traceEvents.query,
      origin: traceEvents.origin,
      tookMs: traceEvents.tookMs,
      errorMessage: traceEvents.errorMessage,
      topK: traceEvents.topK,
      hitCount: traceEvents.hitCount,
      server: traceEvents.server,
      inputTokens: traceEvents.inputTokens,
      outputTokens: traceEvents.outputTokens,
      costUsd: traceEvents.costUsd,
      payload: traceEvents.payload,
    })
    .from(traceEvents)
    .leftJoin(
      runtimeEventSources,
      and(
        eq(runtimeEventSources.projectId, traceEvents.projectId),
        eq(runtimeEventSources.sourceId, traceEvents.sourceId),
      ),
    )
    .where(
      and(
        eq(traceEvents.projectId, projectId),
        eq(traceEvents.ingestSource, "runtime"),
        UUID_PATTERN.test(identifier)
          ? or(eq(traceEvents.id, identifier), eq(traceEvents.eventId, identifier))
          : eq(traceEvents.eventId, identifier),
      ),
    )
    .limit(1);
  return (row as RuntimeEventRow | undefined) ?? null;
}

export async function listRuntimeEventRejects(
  projectId: string,
  filters: Omit<RuntimeEventFilters, "now"> = {},
  db: RuntimeEventsDb = getDb(),
): Promise<RuntimeEventRejectRow[]> {
  return db
    .select({
      id: traceEventRejects.id,
      eventId: traceEventRejects.eventId,
      type: traceEventRejects.type,
      reason: traceEventRejects.reason,
      sizeBytes: traceEventRejects.sizeBytes,
      sourceId: traceEventRejects.sourceId,
      receivedAt: traceEventRejects.receivedAt,
    })
    .from(traceEventRejects)
    .where(runtimeEventRejectWhere(projectId, filters))
    .orderBy(desc(traceEventRejects.receivedAt), desc(traceEventRejects.id))
    .limit(pageSize(filters.limit));
}

export async function countRuntimeEventRejects(
  projectId: string,
  filters: Omit<RuntimeEventFilters, "now" | "limit"> = {},
  db: RuntimeEventsDb = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(traceEventRejects)
    .where(runtimeEventRejectWhere(projectId, filters));
  return row?.count ?? 0;
}

/** Aggregate the SDK's typed `events_dropped` markers (client-side load
 * shedding between flushes) so the Dropped tab can surface losses that never
 * reached the server as individual events. */
export async function summarizeRuntimeEventClientDrops(
  projectId: string,
  filters: Omit<RuntimeEventFilters, "now" | "type"> = {},
  db: RuntimeEventsDb = getDb(),
): Promise<RuntimeEventClientDropGroup[]> {
  const reason = sql<string | null>`${traceEvents.payload}->>'reason'`;
  const droppedCount = sql<number>`coalesce(sum((${traceEvents.payload}->>'dropped_count')::bigint), 0)::int`;
  const rows = await db
    .select({
      sourceId: traceEvents.sourceId,
      reason,
      droppedCount,
      windowCount: sql<number>`count(*)::int`,
      // Raw fragments bypass the column decoders, so reuse the timestamp
      // column's mapper to get a Date back instead of a string.
      lastDropAt: sql<Date>`max(${eventTime})`.mapWith(traceEvents.receivedAt),
    })
    .from(traceEvents)
    .where(
      and(
        eq(traceEvents.projectId, projectId),
        eq(traceEvents.ingestSource, "runtime"),
        eq(traceEvents.type, "events_dropped"),
        filters.sourceId ? eq(traceEvents.sourceId, filters.sourceId) : undefined,
        filters.since ? gte(eventTime, filters.since) : undefined,
        filters.until ? lt(eventTime, filters.until) : undefined,
      ),
    )
    .groupBy(traceEvents.sourceId, reason)
    .orderBy(desc(droppedCount), asc(traceEvents.sourceId), asc(reason))
    .limit(pageSize(filters.limit));
  return rows as RuntimeEventClientDropGroup[];
}

/**
 * How many events the SDK reported dropping in a window, in total: the
 * "Dropped" number on Settings > Developer. One uncapped sum over the
 * `events_dropped` reports, where the grouped summary above returns a page of
 * groups for the list.
 */
export async function sumRuntimeEventClientDrops(
  projectId: string,
  filters: Omit<RuntimeEventFilters, "now" | "type" | "limit"> = {},
  db: RuntimeEventsDb = getDb(),
): Promise<number> {
  const [row] = await db
    .select({
      dropped:
        sql<number>`coalesce(sum((${traceEvents.payload}->>'dropped_count')::bigint), 0)::bigint`.mapWith(
          Number,
        ),
    })
    .from(traceEvents)
    .where(
      and(
        eq(traceEvents.projectId, projectId),
        eq(traceEvents.ingestSource, "runtime"),
        eq(traceEvents.type, "events_dropped"),
        filters.sourceId ? eq(traceEvents.sourceId, filters.sourceId) : undefined,
        filters.since ? gte(eventTime, filters.since) : undefined,
        filters.until ? lt(eventTime, filters.until) : undefined,
      ),
    );
  return row?.dropped ?? 0;
}

export async function listRuntimeEventFacets(
  projectId: string,
  options: { now?: Date } = {},
  db: RuntimeEventsDb = getDb(),
): Promise<RuntimeEventFacets> {
  const now = options.now ?? new Date();
  const typeCutoff = new Date(now.getTime() - 30 * DAY_MS);
  const status = sourceStatus(now);
  const [types, sources] = await Promise.all([
    db
      .select({ type: traceEvents.type })
      .from(traceEvents)
      .where(
        and(
          eq(traceEvents.projectId, projectId),
          eq(traceEvents.ingestSource, "runtime"),
          gte(eventTime, typeCutoff),
        ),
      )
      .groupBy(traceEvents.type)
      .orderBy(asc(traceEvents.type)),
    db
      .select({
        sourceId: runtimeEventSources.sourceId,
        status,
        lastSeenAt: runtimeEventSources.lastSeenAt,
      })
      .from(runtimeEventSources)
      .where(eq(runtimeEventSources.projectId, projectId))
      .orderBy(desc(runtimeEventSources.lastSeenAt), asc(runtimeEventSources.sourceId))
      .limit(MAX_FACET_SOURCES),
  ]);
  return {
    types: types.map(({ type }) => type),
    sources: sources as RuntimeEventFacets["sources"],
  };
}

function sourceStatus(now: Date) {
  const staleCutoff = new Date(now.getTime() - 7 * DAY_MS);
  const dormantCutoff = new Date(now.getTime() - 30 * DAY_MS);
  return sql<RuntimeSourceStatus>`case
    when ${runtimeEventSources.lastSeenAt} is null then 'unknown'
    when ${runtimeEventSources.lastSeenAt} < ${dormantCutoff} then 'dormant'
    when ${runtimeEventSources.lastSeenAt} < ${staleCutoff} then 'stale'
    else 'active'
  end`;
}

function runtimeEventRejectWhere(projectId: string, filters: Omit<RuntimeEventFilters, "now">) {
  return and(
    eq(traceEventRejects.projectId, projectId),
    filters.type ? eq(traceEventRejects.type, filters.type) : undefined,
    filters.sourceId ? eq(traceEventRejects.sourceId, filters.sourceId) : undefined,
    filters.since ? gte(traceEventRejects.receivedAt, filters.since) : undefined,
    filters.until ? lt(traceEventRejects.receivedAt, filters.until) : undefined,
  );
}

function pageSize(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit!)));
}
