import { sql } from "drizzle-orm";
import {
  bigint,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { projects } from "@/lib/platform/projects/schema";

/** SDK runtime events and what consolidation derives from them. Owned fragment of the upstream schema (ADR-0030). */

/**
 * Granular tool/skill **usage** telemetry: the search ledger beside the coarse
 * per-call OTLP pipeline (`events`/`event_metrics`), mirroring
 * the SDK's own `TraceEvent` union (search / skill_search / skill_invoke /
 * invoke_* / gateway_* / upstream_* / auth_*; see `ratel` core `trace/event.rs`).
 * This is where `search_capabilities` query strings land, the raw material for the
 * search views (top queries, match quality, Agent health); the OTLP trace ingest
 * carries tool *names* only.
 *
 * Direct facts arrive through `POST /api/v1/events` and are consolidated into
 * read models in the ingest transaction. Synthetic OTLP search rows remain a
 * compatibility bridge until each source begins publishing facts; that source's
 * facts era then supersedes the overlapping OTLP derivations.
 *
 * Design is a deliberate **hybrid**, not fully normalized and not pure-jsonb:
 * this one polymorphic table carries a `type` discriminator (the verbatim wire
 * tag), the envelope (`schema_version` / `session_id` / `occurred_at` /
 * `received_at`), an idempotency key (`client_event_id` — SDK-supplied or a
 * Cloud-computed content hash), and **promoted scalar columns** for exactly the
 * fields the hot analytics queries filter/group on (`tool_id`, `skill_id`,
 * `query`, `origin`, `took_ms`, `error_message`, `top_k`, `hit_count`,
 * `server`). A full-fidelity `payload` jsonb keeps everything else losslessly —
 * including whole event kinds not yet promoted to columns — so a newer SDK never
 * needs a synchronized Cloud deploy. The nullable `search_id` / `correlation_id`
 * / `catalog_version` / `harness` / `environment` / `end_user_id` /
 * `input_tokens` / `output_tokens` / `cost_usd` columns are forward-compat
 * placeholders for metrics the SDK doesn't emit yet (see
 * `docs/trace-events-metrics-superset.md`); they're additive today so promoting
 * them later is never a breaking change.
 *
 * `id` is deterministic — a uuid derived from `(project_id, client_event_id)` —
 * so a retried flush lands on the same row and `ON CONFLICT DO NOTHING` makes
 * ingestion idempotent (the content-hash key is an approximation until the SDK
 * sends an explicit event id/seq).
 */
export const traceEvents = pgTable(
  "trace_events",
  {
    // Deterministic (not random): uuidv8 of (project_id, client_event_id). Lets a
    // retried batch collide on the PK so ingestion is idempotent.
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // The verbatim wire tag (e.g. "search", "skill_invoke", "invoke_error"). Text,
    // not an enum, so an unrecognized future variant still stores (payload-only).
    type: text("type").notNull(),
    // Envelope: the trace schema version (`v`) and the SDK session the event fired in.
    schemaVersion: integer("schema_version"),
    sessionId: text("session_id"),
    // Event time (from the envelope `ts`, epoch ms) vs. when Cloud received it.
    // Analytics group on occurred_at, falling back to received_at.
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    // Persistence provenance, never producer-controlled. Native runtime rows
    // carry "runtime" so retention cannot touch OTLP-derived reconstructions.
    ingestSource: text("ingest_source"),
    // Idempotency key: the SDK's client_event_id when present, else a content hash
    // of the raw event. (project_id, client_event_id) → the deterministic `id`.
    clientEventId: text("client_event_id").notNull(),
    // Envelope v2 identity. `client_event_id` stays for v1 compatibility; v2's
    // event_id is also the idempotency input and is promoted for direct lookup.
    eventId: text("event_id"),
    sourceId: text("source_id"),
    invocationId: text("invocation_id"),
    traceId: text("trace_id"),
    spanId: text("span_id"),
    // Host-supplied agent-turn correlation (ADR-0014). Pairs a search with the
    // invoke(s) that followed it inside one session; the intent-graph fold keys
    // on (session_id, turn_id). Null when the host passed none.
    turnId: text("turn_id"),
    // — Promoted scalars: the fields the hot queries filter/group on —
    toolId: text("tool_id"),
    skillId: text("skill_id"),
    query: text("query"),
    // "direct" (pre-fetch/library call) | "agent" (synthesized in the loop). Stored
    // verbatim as text so a new origin value never rejects an otherwise-valid event.
    origin: text("origin"),
    tookMs: integer("took_ms"),
    errorMessage: text("error_message"),
    topK: integer("top_k"),
    // Number of hits a search returned (hits.length for search/skill_search; the bare
    // count for gateway_search, whose wire shape is a u32 rather than a hits array).
    hitCount: integer("hit_count"),
    // Upstream MCP server name (upstream_* events).
    server: text("server"),
    // — Forward-compat placeholders (SDK doesn't emit these yet; additive) —
    searchId: text("search_id"),
    correlationId: text("correlation_id"),
    catalogVersion: text("catalog_version"),
    harness: text("harness"),
    environment: text("environment"),
    // The customer's END-user the agent served when this event fired — an opaque
    // SDK-emitted id (NOT the dashboard `users` table). Drives per-user analytics
    // once the SDK starts sending it.
    endUserId: text("end_user_id"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    // Full-fidelity raw event (envelope + all fields) — nothing is lost even for
    // fields/variants not promoted above.
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  },
  (t) => [
    // "Top search queries this week" / "tools erroring most": filter (project, type),
    // range on event time, group. Event time = coalesce(occurred_at, received_at).
    index("trace_events_project_type_time_idx").on(
      t.projectId,
      t.type,
      sql`coalesce(${t.occurredAt}, ${t.receivedAt})`,
    ),
    // "Skills searched-for but never invoked": the anti-join's skill_invoke probe by skill_id.
    index("trace_events_project_type_skill_idx").on(t.projectId, t.type, t.skillId),
    // "Tools erroring most": group errors by tool_id within the error variants.
    index("trace_events_project_type_tool_idx").on(t.projectId, t.type, t.toolId),
    index("trace_events_project_source_time_idx")
      .on(t.projectId, t.sourceId, t.receivedAt)
      .where(sql`${t.sourceId} is not null`),
    index("trace_events_project_trace_idx")
      .on(t.projectId, t.traceId, t.spanId)
      .where(sql`${t.traceId} is not null`),
    index("trace_events_project_event_idx")
      .on(t.projectId, t.eventId)
      .where(sql`${t.eventId} is not null`),
    index("trace_events_ingest_source_received_idx")
      .on(t.ingestSource, t.receivedAt, t.id)
      .where(sql`${t.ingestSource} is not null`),
    index("trace_events_project_ingest_time_idx").on(
      t.projectId,
      t.ingestSource,
      sql`coalesce(${t.occurredAt}, ${t.receivedAt})`,
    ),
    // The intent-graph fold's cursor scan: both lanes' learning event types for
    // a project in received order, from the fold cursor forward. Partial so it
    // stays small on projects that emit mostly churn / auth events. The list
    // is `FOLD_EVENT_TYPES` + `OTLP_FOLD_EVENT_TYPES` spelled out, since the
    // migration holds this SQL verbatim; keep it in step with those lists.
    index("trace_events_project_received_fold_idx")
      .on(t.projectId, t.receivedAt, t.id)
      .where(
        sql`${t.type} in ('search', 'skill_search', 'invoke_start', 'skill_invoke', 'otlp_model_call', 'invoke_end', 'invoke_error')`,
      ),
    // Per-user analytics: the hot index with the end-user dimension. Partial so it
    // stays empty (zero write cost) until the SDK starts emitting end_user_id.
    index("trace_events_project_user_type_time_idx")
      .on(t.projectId, t.endUserId, t.type, sql`coalesce(${t.occurredAt}, ${t.receivedAt})`)
      .where(sql`${t.endUserId} is not null`),
    // The turn-ledger builder's cursor scan (Agent health): the searches and
    // invocations of a project in received order, from the build cursor forward.
    // Partial so it skips churn, auth, catalog and upstream events. Keep the type
    // list in step with TURN_EVENT_TYPES in lib/trace-signals/constants.ts.
    index("trace_events_project_received_turn_idx")
      .on(t.projectId, t.receivedAt, t.id)
      .where(
        sql`${t.type} in ('search', 'skill_search', 'gateway_search', 'invoke_start', 'invoke_end', 'invoke_error', 'gateway_invoke', 'gateway_error', 'skill_invoke')`,
      ),
  ],
);

/**
 * The one relation worth normalizing out of {@link traceEvents}: a row per hit in
 * a `search` / `skill_search` event's `hits` array, so "which skills were surfaced
 * in search but never invoked" is a plain anti-join instead of a jsonb scan.
 * `project_id` is promoted here (denormalized from the parent) so that query never
 * has to join back to `trace_events` just to scope by project.
 *
 * Known gap: `gateway_search.hits` is a bare count (u32) in the current SDK wire
 * schema, not an array — so gateway-mediated searches can't populate this table
 * yet (they still record `hit_count` on the parent). Fixable only SDK-side.
 */
export const traceEventHits = pgTable(
  "trace_event_hits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    traceEventId: uuid("trace_event_id")
      .notNull()
      .references(() => traceEvents.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // Denormalized from the parent event (same rationale as project_id): lets the
    // per-user "surfaced but never invoked" anti-join skip the parent join.
    endUserId: text("end_user_id"),
    // 0-based position of this hit in the search's ranked results.
    rank: integer("rank").notNull(),
    // "tool" | "skill" — which catalog the hit points into.
    targetType: text("target_type").notNull(),
    // The tool_id / skill_id that was surfaced, and its retrieval score.
    targetId: text("target_id").notNull(),
    score: doublePrecision("score"),
  },
  (t) => [
    // Natural key + idempotency: a retried search never double-inserts its hits.
    uniqueIndex("trace_event_hits_event_rank_idx").on(t.traceEventId, t.rank),
    // The anti-join's driving scan: skill hits for a project by target_id.
    index("trace_event_hits_project_target_idx").on(t.projectId, t.targetType, t.targetId),
  ],
);

/** Metadata-only dead-letter ledger for per-item runtime-event rejections. */
export const traceEventRejects = pgTable(
  "trace_event_rejects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    eventId: text("event_id"),
    type: text("type"),
    reason: text("reason").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sourceId: text("source_id"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("trace_event_rejects_project_time_idx").on(t.projectId, t.receivedAt),
    index("trace_event_rejects_received_at_idx").on(t.receivedAt, t.id),
  ],
);

/** Exact, idempotently consolidated invocation totals from direct runtime facts. */
export const toolUsageCounters = pgTable(
  "tool_usage_counters",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sourceId: text("source_id").notNull(),
    toolId: text("tool_id").notNull(),
    calls: bigint("calls", { mode: "number" }).notNull().default(0),
    errors: bigint("errors", { mode: "number" }).notNull().default(0),
    totalDurationMs: bigint("total_duration_ms", { mode: "number" }).notNull().default(0),
    firstUsedAt: timestamp("first_used_at", { withTimezone: true }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.sourceId, t.toolId] }),
    index("tool_usage_counters_project_calls_idx").on(t.projectId, t.calls),
  ],
);

export type TraceEvent = typeof traceEvents.$inferSelect;
export type NewTraceEvent = typeof traceEvents.$inferInsert;
export type TraceEventHit = typeof traceEventHits.$inferSelect;
export type NewTraceEventHit = typeof traceEventHits.$inferInsert;
export type TraceEventReject = typeof traceEventRejects.$inferSelect;
export type NewTraceEventReject = typeof traceEventRejects.$inferInsert;
export type ToolUsageCounter = typeof toolUsageCounters.$inferSelect;
export type NewToolUsageCounter = typeof toolUsageCounters.$inferInsert;
