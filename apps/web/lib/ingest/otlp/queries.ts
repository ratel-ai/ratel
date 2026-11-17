import {
  and,
  eq,
  getTableColumns,
  gte,
  inArray,
  isNull,
  lt,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { CategorySplits, ToolsByName } from "@/lib/ingest/categorize";
import type { ContextSource } from "@/lib/ingest/context";
import {
  eventMetrics,
  events,
  type NewEvent,
  type NewEventMetric,
  type NewOtelLog,
  type NewOtelSpan,
  otelLogs,
  otelSpans,
} from "@/lib/ingest/otlp/schema";
import { upsertRuntimeCatalogEntries } from "@/lib/ingest/runtime-catalog/queries";
import type { NewRuntimeCatalogEntry } from "@/lib/ingest/runtime-catalog/schema";
import { getDb } from "@/lib/platform/db/client";
import type { BoundReadDb } from "@/lib/platform/db/statement-timeout";
import { getLogger } from "@/lib/platform/logger";
import { reportServerException } from "@/lib/platform/telemetry";
import { NON_ROUND_TRIP_OPERATIONS } from "./constants";

/**
 * The event, span and log writes, and the derived-metric reads the overview and the MCP cost
 * tools take (owned fragment of the upstream queries hub, ADR-0030).
 */

/** A raw event paired with the metrics derived from it: the unit of ingest. */
export type EventWithMetric = {
  event: NewEvent;
  /** Everything but the FK/id/project, which this helper fills after insert. */
  metric: Omit<NewEventMetric, "id" | "eventId" | "projectId">;
};

export type EventsDb = Pick<ReturnType<typeof getDb>, "insert">;

/** A per-source token map for one aggregate bucket. */
export type SourceSums = Record<ContextSource, number>;

/** One UTC day of `event_metrics`, the shape the dashboard model folds. */
export type DailyAggregateRow = {
  day: string;
  /** Input tokens per source (from event_metrics.tokens_by_category). */
  spend: SourceSums;
  /** History cached/uncached + tools used/unused, summed for the day. */
  splits: CategorySplits;
  outputTokens: number;
  latencyMs: number;
  costUsd: number;
  runs: number;
};

/**
 * Store a batch of agent events and their derived metrics (ADR-0013). Raw events go into
 * `events` with `ON CONFLICT (project_id, dedupe_hash) DO NOTHING` so SDK retries are
 * idempotent; one `event_metrics` row per freshly inserted event. Not one transaction, so a
 * crash between the two inserts leaves an event with no metrics row. Returns the number of
 * newly stored events.
 */
export async function insertEventsWithMetrics(
  projectId: string,
  rows: EventWithMetric[],
  db: EventsDb = getDb(),
): Promise<number> {
  if (rows.length === 0) return 0;

  // Collapse duplicate events within the batch (same dedupe hash) up front so the
  // insert values are already unique: one metric row per stored event. Ingest always
  // sets a hash; the null guard only satisfies the (nullable-for-legacy) column type.
  const byHash = new Map<string, EventWithMetric>();
  for (const r of rows) {
    const h = r.event.dedupeHash;
    if (h != null && !byHash.has(h)) byHash.set(h, r);
  }
  const unique = [...byHash.values()];

  const inserted = await db
    .insert(events)
    .values(unique.map((r) => r.event))
    .onConflictDoNothing({ target: [events.projectId, events.dedupeHash] })
    .returning({ id: events.id, dedupeHash: events.dedupeHash });
  if (inserted.length === 0) return 0;

  const metricRows: NewEventMetric[] = [];
  for (const e of inserted) {
    const r = e.dedupeHash != null ? byHash.get(e.dedupeHash) : undefined;
    if (r) metricRows.push({ ...r.metric, eventId: e.id, projectId });
  }
  if (metricRows.length > 0) await db.insert(eventMetrics).values(metricRows);

  return inserted.length;
}

export type EventPresenceDb = Pick<ReturnType<typeof getDb>, "select">;

/** Whether the project has stored at least one event: the first question a reader asks of it. */
export async function hasProjectIngestedEvents(
  projectId: string,
  db: EventPresenceDb = getDb(),
): Promise<boolean> {
  const rows = await db
    .select({ id: events.id })
    .from(events)
    .where(eq(events.projectId, projectId))
    .limit(1);
  return rows.length > 0;
}

/**
 * Per-day token/cost/latency aggregates for a project since `since`, grouped by
 * UTC day. Reads the derived `event_metrics` table (not raw events): the day is
 * the run's *event* time — occurred_at, falling back to received_at — denormalized
 * into `event_time`, so buffered flushes and backfills land on the day they
 * happened. Per-source sums are pulled from the two JSONB maps
 * (tokens_by_category / splits) and cast to float8 so they round-trip as JS
 * numbers. Uses event_metrics_project_time_idx. An optional `until` (exclusive)
 * caps the window's top end for past ranges.
 */
export async function getDailyAggregates(
  projectId: string,
  since: Date,
  until?: Date,
  db: EventPresenceDb = getDb(),
): Promise<DailyAggregateRow[]> {
  const eventTime = eventMetrics.eventTime;
  const day = sql<string>`to_char(date_trunc('day', ${eventTime}), 'YYYY-MM-DD')`;
  const sumSrc = (col: AnyPgColumn, k: string) =>
    sql<number>`coalesce(sum((${col} ->> ${k})::numeric), 0)::float8`;

  const rows = await db
    .select({
      day,
      spend_skills: sumSrc(eventMetrics.tokensByCategory, "skills"),
      spend_tools: sumSrc(eventMetrics.tokensByCategory, "tools"),
      spend_history: sumSrc(eventMetrics.tokensByCategory, "history"),
      spend_memory: sumSrc(eventMetrics.tokensByCategory, "memory"),
      spend_user_input: sumSrc(eventMetrics.tokensByCategory, "user_input"),
      history_cached: sumSrc(eventMetrics.splits, "history_cached"),
      history_uncached: sumSrc(eventMetrics.splits, "history_uncached"),
      tools_used: sumSrc(eventMetrics.splits, "tools_used"),
      tools_unused: sumSrc(eventMetrics.splits, "tools_unused"),
      outputTokens: sql<number>`coalesce(sum(${eventMetrics.outputTokens}), 0)::float8`,
      latencyMs: sql<number>`coalesce(sum(${eventMetrics.latencyMs}), 0)::float8`,
      costUsd: sql<number>`coalesce(sum(${eventMetrics.costUsd}), 0)::float8`,
      runs: sql<number>`count(*)::int`,
    })
    .from(eventMetrics)
    .where(
      and(
        eq(eventMetrics.projectId, projectId),
        gte(eventTime, since),
        until ? lt(eventTime, until) : undefined,
      ),
    )
    .groupBy(day)
    .orderBy(day);

  return rows.map((r) => ({
    day: r.day,
    spend: {
      skills: r.spend_skills,
      tools: r.spend_tools,
      history: r.spend_history,
      memory: r.spend_memory,
      user_input: r.spend_user_input,
    },
    splits: {
      history_cached: r.history_cached,
      history_uncached: r.history_uncached,
      tools_used: r.tools_used,
      tools_unused: r.tools_unused,
    },
    outputTokens: r.outputTokens,
    latencyMs: r.latencyMs,
    costUsd: r.costUsd,
    runs: r.runs,
  }));
}

/** Cached and total input tokens over a window, for the prompt cache hit rate. */
export type PromptCacheTotals = { cachedTokens: number; inputTokens: number };

/**
 * The window's summed `cached_tokens` and `input_tokens` (RC-382). Reads
 * `events`, since `event_metrics` holds no cached count, over the same event
 * time (`coalesce(occurred_at, received_at)`, events_project_event_time_idx)
 * as {@link getDailyAggregates}. Unlike the history split, it counts every
 * cached token, a cached system prompt included.
 */
export async function getPromptCacheTotals(
  projectId: string,
  since: Date,
  until?: Date,
  db: BoundReadDb = getDb(),
): Promise<PromptCacheTotals> {
  const eventTime = sql`coalesce(${events.occurredAt}, ${events.receivedAt})`;
  const [row] = await db
    .select({
      cachedTokens: sql<number>`coalesce(sum(${events.cachedTokens}), 0)::float8`,
      inputTokens: sql<number>`coalesce(sum(${events.inputTokens}), 0)::float8`,
    })
    .from(events)
    .where(
      and(
        eq(events.projectId, projectId),
        gte(eventTime, since),
        until ? lt(eventTime, until) : undefined,
      ),
    );
  return { cachedTokens: row?.cachedTokens ?? 0, inputTokens: row?.inputTokens ?? 0 };
}

/** Every run's per-tool footprint in the window, one map per `event_metrics` row (the Tools tab folds them). */
export async function getToolMetrics(
  projectId: string,
  since: Date,
  until?: Date,
  db: EventPresenceDb = getDb(),
): Promise<ToolsByName[]> {
  const eventTime = eventMetrics.eventTime;
  const rows = await db
    .select({ toolsByName: eventMetrics.toolsByName })
    .from(eventMetrics)
    .where(
      and(
        eq(eventMetrics.projectId, projectId),
        gte(eventTime, since),
        until ? lt(eventTime, until) : undefined,
      ),
    );
  return rows.map((r) => r.toolsByName);
}

export type OtelSpansDb = Pick<ReturnType<typeof getDb>, "insert" | "transaction">;

const OTEL_SPAN_INSERT_CHUNK_SIZE = 500;

/**
 * What a stored span with the same id gets. `ignore` (live OTLP ingest): it is
 * kept, so a retried export is a no-op. `update` (Agent health imports and their
 * reprocess): it takes every decoded column of the new row, so a mapper fix
 * reaches the spans already stored.
 */
export type OtelSpanConflict = "ignore" | "update";

/** The columns an import rewrite replaces: all but the key and the project. */
const OTEL_SPAN_REWRITE_SET = Object.fromEntries(
  Object.entries(getTableColumns(otelSpans))
    .filter(([key]) => key !== "id" && key !== "projectId" && key !== "receivedAt")
    .map(([key, column]) => [key, sql.raw(`excluded."${column.name}"`)]),
);

/**
 * Persist a bounded batch of mapped OTLP spans.
 *
 * Duplicate deterministic ids are collapsed before writing, and each statement
 * stays below the PostgreSQL parameter ceiling. `accepted` counts new rows only.
 * With `onConflict: "update"`, a rewritten row is counted in `updated` and gets a
 * new `received_at`, so the trace summary sweep recomputes its trace.
 */
export async function insertOtelSpans(
  projectId: string,
  rows: NewOtelSpan[],
  db: OtelSpansDb = getDb(),
  { onConflict = "ignore" }: { onConflict?: OtelSpanConflict } = {},
): Promise<{ accepted: number; updated?: number }> {
  if (rows.length === 0)
    return onConflict === "update" ? { accepted: 0, updated: 0 } : { accepted: 0 };

  const byId = new Map<string, NewOtelSpan>();
  for (const row of rows) {
    if (!byId.has(row.id)) byId.set(row.id, { ...row, projectId });
  }

  const uniqueRows = [...byId.values()];
  return db.transaction(async (tx) => {
    let accepted = 0;
    let updated = 0;
    for (let offset = 0; offset < uniqueRows.length; offset += OTEL_SPAN_INSERT_CHUNK_SIZE) {
      const insert = tx
        .insert(otelSpans)
        .values(uniqueRows.slice(offset, offset + OTEL_SPAN_INSERT_CHUNK_SIZE));
      if (onConflict === "ignore") {
        accepted += (await insert.onConflictDoNothing().returning({ id: otelSpans.id })).length;
        continue;
      }
      const written = await insert
        .onConflictDoUpdate({
          target: otelSpans.id,
          set: { ...OTEL_SPAN_REWRITE_SET, receivedAt: sql`now()` },
          // A row of another project is never rewritten (ids are per project anyway).
          setWhere: sql`${otelSpans.projectId} = excluded."project_id"`,
        })
        // `xmax = 0` only on a row this statement inserted; an updated row has the updating transaction's id.
        .returning({ inserted: sql<boolean>`(xmax = 0)` });
      for (const row of written) {
        if (row.inserted) accepted += 1;
        else updated += 1;
      }
    }
    return onConflict === "update" ? { accepted, updated } : { accepted };
  });
}

export type OtelLogsDb = Pick<ReturnType<typeof getDb>, "insert" | "transaction">;

const OTEL_LOG_INSERT_CHUNK_SIZE = 500;
const otelLogsLogger = getLogger("db/otel-logs");

/**
 * Idempotently persist a bounded batch of mapped OTLP log events, and the runtime catalog
 * definitions they carry. Duplicate deterministic ids are collapsed before writing, and each
 * statement stays below the PostgreSQL parameter ceiling.
 */
export async function insertOtelLogs(
  projectId: string,
  rows: Array<NewOtelLog & { catalogDefinition?: Omit<NewRuntimeCatalogEntry, "projectId"> }>,
  db: OtelLogsDb = getDb(),
): Promise<{ accepted: number }> {
  if (rows.length === 0) return { accepted: 0 };

  const byId = new Map<string, NewOtelLog>();
  const definitions = new Map<string, NewRuntimeCatalogEntry>();
  for (const row of rows) {
    const { catalogDefinition, ...logRow } = row;
    if (!byId.has(row.id)) byId.set(row.id, { ...logRow, projectId });
    if (catalogDefinition) {
      const key = `${catalogDefinition.kind}\0${catalogDefinition.entryId}`;
      const current = definitions.get(key);
      const seenAt = catalogDefinition.lastSeenAt?.getTime() ?? -Infinity;
      const currentSeenAt = current?.lastSeenAt?.getTime() ?? -Infinity;
      if (!current || seenAt > currentSeenAt) {
        definitions.set(key, { ...catalogDefinition, projectId });
      }
    }
  }

  const uniqueRows = [...byId.values()];
  const result = await db.transaction(async (tx) => {
    let accepted = 0;
    for (let offset = 0; offset < uniqueRows.length; offset += OTEL_LOG_INSERT_CHUNK_SIZE) {
      const inserted = await tx
        .insert(otelLogs)
        .values(uniqueRows.slice(offset, offset + OTEL_LOG_INSERT_CHUNK_SIZE))
        .onConflictDoNothing()
        .returning({ id: otelLogs.id });
      accepted += inserted.length;
    }
    return { accepted };
  });

  if (definitions.size > 0) {
    try {
      await upsertRuntimeCatalogEntries([...definitions.values()], "events", db);
    } catch (error) {
      otelLogsLogger.error(
        { err: error, project_id: projectId, definition_count: definitions.size },
        "runtime catalog upsert failed",
      );
      reportServerException(error, `project:${projectId}`, {
        component: "runtime_catalog_upsert",
        definition_count: definitions.size,
      });
    }
  }

  return result;
}

/**
 * The subset of `traceIds` with a stored model-call span: an `llm_call` that is neither an
 * agent wrapper nor an embeddings or retrieval operation. Feeds the agent-span dedupe,
 * which must not count a wrapper's summed usage as one more call; uses
 * `otel_spans_project_trace_idx`.
 */
export async function findTracesWithModelCalls(
  projectId: string,
  traceIds: string[],
  db: Pick<ReturnType<typeof getDb>, "selectDistinct"> = getDb(),
): Promise<Set<string>> {
  if (traceIds.length === 0) return new Set();
  const rows = await db
    .selectDistinct({ traceId: otelSpans.traceId })
    .from(otelSpans)
    .where(
      and(
        eq(otelSpans.projectId, projectId),
        inArray(otelSpans.traceId, traceIds),
        eq(otelSpans.spanClass, "llm_call"),
        or(
          isNull(otelSpans.operationName),
          notInArray(otelSpans.operationName, [...NON_ROUND_TRIP_OPERATIONS]),
        ),
      ),
    );
  return new Set(rows.map((row) => row.traceId));
}
