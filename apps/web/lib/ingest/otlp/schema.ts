import { sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { CategorySplits, ToolsByName } from "@/lib/ingest/categorize";
import type { CloudEvent } from "@/lib/ingest/cloud-schema";
import type { ContextSource } from "@/lib/ingest/context";
import { projects } from "@/lib/platform/projects/schema";

/** Raw telemetry the OTLP and legacy event routes write. Owned fragment of the upstream schema (ADR-0030). */

/**
 * Raw agent events (ADR-0013 landing zone). One row per LLM call the SDK sends —
 * a typed header (provider/model/usage) for cheap querying plus the verbatim
 * `payload` so metrics can be re-derived when the categorizer improves. The
 * dashboard does NOT read this table; it reads the derived `event_metrics`.
 */
export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // When we received it vs. when the run actually happened (the event `ts`).
    // Derived metrics group on the event time — occurred_at, falling back to
    // received_at when absent (see events_project_event_time_idx).
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    // Resolved provider/model + normalized usage, lifted out of the payload for
    // indexable queries and cost (input_tokens minus cached at the discounted rate).
    provider: text("provider"),
    model: text("model"),
    stream: boolean("stream"),
    finishReason: text("finish_reason"),
    latencyMs: integer("latency_ms"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cachedTokens: integer("cached_tokens"),
    reasoningTokens: integer("reasoning_tokens"),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    // The full, unmodified ADR-0013 event (messages, tools, params, …). The raw
    // material the categorizer re-runs against. Nullable only so the reshape can add
    // it to a populated table without wiping history — every new ingest sets it, and
    // pre-ADR-0013 rows (no raw payload) stay as inert, uncategorizable history.
    payload: jsonb("payload").$type<CloudEvent>(),
    // sha256 of provider+model+ts+messages — dedup key for best-effort retries.
    // Nullable for the same back-compat reason (Postgres treats NULLs as distinct,
    // so the unique index below never collides on legacy rows).
    dedupeHash: text("dedupe_hash"),
    // Which categorizer version produced this row's metrics (drives backfill).
    categorizerVersion: integer("categorizer_version"),
    // The OpenTelemetry trace and span the event came from, when it came from
    // OTLP: joins a captured reply to its turn (`otlp:<trace id>`) exactly.
    // Null for SDK events and rows written before these columns existed.
    traceId: text("trace_id"),
    spanId: text("span_id"),
  },
  (t) => [
    index("events_project_trace_idx")
      .on(t.projectId, t.traceId)
      .where(sql`${t.traceId} is not null`),
    // Ordering/backfill scan on event time.
    index("events_project_event_time_idx").on(
      t.projectId,
      sql`coalesce(${t.occurredAt}, ${t.receivedAt})`,
    ),
    // Idempotent ingest: ON CONFLICT (project_id, dedupe_hash) DO NOTHING.
    uniqueIndex("events_project_dedupe_idx").on(t.projectId, t.dedupeHash),
  ],
);

/**
 * Derived per-event dashboard metrics (ADR-0013 silver table). Exactly one row
 * per `events` row, computed by `categorize()` at ingest. The dashboard's daily
 * aggregates scan THIS table, so the heavy raw payload never touches the hot path.
 * On a categorizer upgrade the backfill recomputes these rows from `events.payload`.
 */
export const eventMetrics = pgTable(
  "event_metrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // occurred_at ?? received_at, denormalized so the dashboard groups on one column.
    eventTime: timestamp("event_time", { withTimezone: true }).notNull(),
    // Input tokens per source; sums to input_tokens. Same 5 keys as CONTEXT_SOURCES.
    tokensByCategory: jsonb("tokens_by_category").$type<Record<ContextSource, number>>().notNull(),
    // The two sub-splits: history cached/uncached and tools used/unused.
    splits: jsonb("splits").$type<CategorySplits>().notNull(),
    // Per-tool calls + token footprint (keyed by tool name) — feeds the Tools tab.
    toolsByName: jsonb("tools_by_name").$type<ToolsByName>().notNull().default({}),
    toolsTotalCount: integer("tools_total_count").notNull().default(0),
    toolsUsedCount: integer("tools_used_count").notNull().default(0),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    latencyMs: integer("latency_ms"),
    categorizerVersion: integer("categorizer_version").notNull(),
  },
  (t) => [
    // The dashboard's range scan + grouping on event time.
    index("event_metrics_project_time_idx").on(t.projectId, t.eventTime),
    // 1:1 with events — also the upsert target for the backfill.
    uniqueIndex("event_metrics_event_id_idx").on(t.eventId),
  ],
);

/**
 * Raw OpenTelemetry spans retained for trace browsing and experiment analysis.
 *
 * The primary key is deterministic (uuidv8 of project + trace/span ids), so
 * retried OTLP exports collide cleanly. Frequently filtered attributes are
 * promoted; `attributes` keeps a bounded, content-stripped namespace allowlist.
 */
export const otelSpans = pgTable(
  "otel_spans",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    traceId: text("trace_id").notNull(),
    spanId: text("span_id").notNull(),
    // Shared runtime-facts correlation. `source_id` falls back to service.name
    // on OTLP ingest because that is the runtime publisher's default identity.
    eventId: text("event_id"),
    sourceId: text("source_id"),
    parentSpanId: text("parent_span_id"),
    name: text("name").notNull(),
    kind: integer("kind").notNull(),
    spanClass: text("span_class").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }).notNull(),
    durationMs: doublePrecision("duration_ms").notNull(),
    statusCode: integer("status_code").notNull(),
    serviceName: text("service_name"),
    scopeName: text("scope_name"),
    operationName: text("operation_name"),
    providerName: text("provider_name"),
    model: text("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cachedTokens: integer("cached_tokens"),
    reasoningTokens: integer("reasoning_tokens"),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    searchOrigin: text("search_origin"),
    searchTarget: text("search_target"),
    searchQuery: text("search_query"),
    searchTopK: integer("search_top_k"),
    searchHitCount: integer("search_hit_count"),
    experimentName: text("experiment_name"),
    experimentArm: text("experiment_arm"),
    experimentRole: text("experiment_role"),
    experimentAttrs: jsonb("experiment_attrs")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    attributes: jsonb("attributes").$type<Record<string, unknown>>().notNull(),
    attrsTruncated: boolean("attrs_truncated").notNull().default(false),
  },
  (t) => [
    index("otel_spans_received_at_idx").on(t.receivedAt, t.id),
    index("otel_spans_project_trace_idx").on(t.projectId, t.traceId),
    index("otel_spans_project_event_idx")
      .on(t.projectId, t.eventId)
      .where(sql`${t.eventId} is not null`),
    // trace_id rides along so window scans that only need trace ids (e.g. the
    // rootless-trace candidate probe in listTraces) stay index-only.
    index("otel_spans_project_started_trace_idx").on(t.projectId, t.startedAt, t.traceId),
    index("otel_spans_project_roots_started_idx")
      .on(t.projectId, t.startedAt)
      .where(sql`${t.parentSpanId} is null`),
    index("otel_spans_project_experiment_started_idx")
      .on(t.projectId, t.experimentName, t.experimentArm, t.startedAt)
      .where(sql`${t.experimentName} is not null`),
    // Orders spans within a trace by the canonical-root key so experiment
    // detection's DISTINCT ON representative pick is index-only (no Sort). With
    // project_id and trace_id fixed the index order equals the `reps` ORDER BY.
    index("otel_spans_project_trace_root_idx").on(
      t.projectId,
      t.traceId,
      sql`(${t.parentSpanId} is null) desc`,
      t.startedAt,
      t.spanId,
    ),
  ],
);

/**
 * Filtered OpenTelemetry log events retained for experiment lifecycle analysis.
 *
 * Deterministic ids make exporter retries idempotent. Frequently queried
 * experiment fields are promoted while bounded attributes retain the remaining
 * structured event data.
 */
export const otelLogs = pgTable(
  "otel_logs",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    eventName: text("event_name").notNull(),
    eventId: text("event_id"),
    sourceId: text("source_id"),
    ingestSource: text("ingest_source"),
    traceId: text("trace_id"),
    spanId: text("span_id"),
    severityNumber: integer("severity_number").notNull().default(0),
    serviceName: text("service_name"),
    scopeName: text("scope_name"),
    body: jsonb("body"),
    experimentName: text("experiment_name"),
    experimentArm: text("experiment_arm"),
    experimentRole: text("experiment_role"),
    experimentSelectionId: text("experiment_selection_id"),
    experimentAttrs: jsonb("experiment_attrs")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    attributes: jsonb("attributes").$type<Record<string, unknown>>().notNull(),
    attrsTruncated: boolean("attrs_truncated").notNull().default(false),
  },
  (t) => [
    index("otel_logs_received_at_idx").on(t.receivedAt, t.id),
    index("otel_logs_project_occurred_idx").on(t.projectId, t.occurredAt, t.id),
    index("otel_logs_project_trace_idx")
      .on(t.projectId, t.traceId)
      .where(sql`${t.traceId} is not null`),
    index("otel_logs_project_event_idx")
      .on(t.projectId, t.eventId)
      .where(sql`${t.eventId} is not null`),
    index("otel_logs_project_event_occurred_idx").on(t.projectId, t.eventName, t.occurredAt),
    index("otel_logs_project_experiment_occurred_idx")
      .on(t.projectId, t.experimentName, t.experimentArm, t.occurredAt)
      .where(sql`${t.experimentName} is not null`),
    index("otel_logs_project_selection_idx")
      .on(t.projectId, t.experimentSelectionId)
      .where(sql`${t.experimentSelectionId} is not null`),
  ],
);

export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
export type EventMetricRow = typeof eventMetrics.$inferSelect;
export type NewEventMetric = typeof eventMetrics.$inferInsert;
export type OtelSpan = typeof otelSpans.$inferSelect;
export type NewOtelSpan = typeof otelSpans.$inferInsert;
export type OtelLog = typeof otelLogs.$inferSelect;
export type NewOtelLog = typeof otelLogs.$inferInsert;
