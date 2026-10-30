import type { CategorySplits } from "@/lib/ingest/categorize";
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
import { getLogger } from "@/lib/platform/logger";
import { reportServerException } from "@/lib/platform/telemetry";

/** The event, span and log writes (owned fragment of the upstream queries hub, ADR-0030). */

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

export type OtelSpansDb = Pick<ReturnType<typeof getDb>, "insert" | "transaction">;

const OTEL_SPAN_INSERT_CHUNK_SIZE = 500;

/**
 * Idempotently persist a bounded batch of mapped OTLP spans. Duplicate deterministic ids are
 * collapsed before writing, and each statement stays below the PostgreSQL parameter ceiling.
 */
export async function insertOtelSpans(
  projectId: string,
  rows: NewOtelSpan[],
  db: OtelSpansDb = getDb(),
): Promise<{ accepted: number }> {
  if (rows.length === 0) return { accepted: 0 };

  const byId = new Map<string, NewOtelSpan>();
  for (const row of rows) {
    if (!byId.has(row.id)) byId.set(row.id, { ...row, projectId });
  }

  const uniqueRows = [...byId.values()];
  return db.transaction(async (tx) => {
    let accepted = 0;
    for (let offset = 0; offset < uniqueRows.length; offset += OTEL_SPAN_INSERT_CHUNK_SIZE) {
      const inserted = await tx
        .insert(otelSpans)
        .values(uniqueRows.slice(offset, offset + OTEL_SPAN_INSERT_CHUNK_SIZE))
        .onConflictDoNothing()
        .returning({ id: otelSpans.id });
      accepted += inserted.length;
    }
    return { accepted };
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
