import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { projects } from "@/lib/platform/projects/schema";

/**
 * The turn ledger: one row per agent turn, derived from `trace_events` +
 * `trace_event_hits` by the `build_trace_turns` job (`lib/ledger/turns/`). Durable on
 * purpose: raw runtime events are pruned after 30 days, and this table is what every
 * reading above it works from, so a 90-day window survives the prune. Owned fragment
 * of the upstream schema (ADR-0030).
 *
 * A turn is either host-declared (`turn_source = 'declared'`, keyed on the envelope's
 * `turn_id`), inferred from timing within one session (`'inferred'`, keyed on its first
 * event id), or one OTLP trace (`'otlp'`). `turn_key` is stable across rebuilds, which is
 * what lets the builder upsert an open turn every time new events for its session land.
 *
 * `status` is `open` until the turn is followed by another (`ended_by = 'next_turn' |
 * 'gap' | 'cap'`) or its session goes quiet (`'idle'`). Readings read closed turns only.
 * The fact columns are the aggregate of the turn's steps and are recomputed with them;
 * `abandoned` and `first_try` are null when the turn cannot measure them.
 *
 * PRIVACY: no query text, error text or end-user id is ever stored here.
 * `end_user_key` is a salted hash (`lib/ledger/hash.ts`).
 */
export const traceTurns = pgTable(
  "trace_turns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sourceId: text("source_id"),
    sessionId: text("session_id").notNull(),
    // "declared:<turn_id>" | "inferred:<first event id>" | "otlp:<trace id>".
    turnKey: text("turn_key").notNull(),
    // "declared" | "inferred" | "otlp".
    turnSource: text("turn_source").notNull(),
    // "runtime" | "otlp": which ingest lane the turn's events came from.
    lane: text("lane").notNull(),
    // Salted sha256 of the envelope's end_user_id; null when none was sent.
    endUserKey: text("end_user_key"),
    // "open" | "closed".
    status: text("status").notNull().default("open"),
    // "next_turn" | "gap" | "cap" | "idle"; null while open.
    endedBy: text("ended_by"),
    // Event time of the first and last step. `ended_at` moves while the turn is open.
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }).notNull(),
    // Latest receipt time of any event in the turn; the idle-close clock.
    lastReceivedAt: timestamp("last_received_at", { withTimezone: true }).notNull(),
    searchCount: integer("search_count").notNull().default(0),
    invokeCount: integer("invoke_count").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
    distinctTools: integer("distinct_tools").notNull().default(0),
    // Searches that follow an invocation inside the same turn.
    reSearchCount: integer("re_search_count").notNull().default(0),
    // Sum of every search's hit count.
    hitsTotal: integer("hits_total").notNull().default(0),
    // Searched and never invoked. Null on the OTLP lane, which has no invocations yet.
    abandoned: boolean("abandoned"),
    // The agent needed more than one search to reach a tool it ran.
    detour: boolean("detour").notNull().default(false),
    // Every tool it ran was listed by the turn's first search. Null without both a
    // search and an invocation to compare.
    firstTry: boolean("first_try"),
    // An event arrived with an earlier timestamp than the one before it; gaps
    // inside this turn were clamped to zero.
    clockSuspect: boolean("clock_suspect").notNull().default(false),
    // The task (Agent health workflow id) this run belongs to, set by each
    // signal run; null when the run matches no task.
    workflowId: text("workflow_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("trace_turns_project_session_key_idx").on(t.projectId, t.sessionId, t.turnKey),
    // Runs of one task, for the task page and per-task numbers.
    index("trace_turns_project_workflow_idx")
      .on(t.projectId, t.workflowId, t.endedAt)
      .where(sql`${t.workflowId} is not null`),
    // The builder's reload of open (and idle-closed) turns for a page's sessions.
    index("trace_turns_project_session_status_idx").on(t.projectId, t.sessionId, t.status),
    // The idle close: open turns whose session went quiet.
    index("trace_turns_open_received_idx")
      .on(t.projectId, t.lastReceivedAt)
      .where(sql`${t.status} = 'open'`),
    // The readings page closed turns by (ended_at, id).
    index("trace_turns_closed_ended_idx")
      .on(t.projectId, t.endedAt, t.id)
      .where(sql`${t.status} = 'closed'`),
  ],
);

/**
 * One row per search or invocation inside a {@link traceTurns} row: the attribution
 * record. A step carries everything the segmenter reads (times, source event ids, the
 * declared flag, hit ids), so an open turn is re-derived from `stored steps + new
 * events` with the same result a full rebuild gives.
 *
 * `trace_event_id` / `end_trace_event_id` point at the source `trace_events` rows
 * without a foreign key: those rows are pruned after 30 days and the step must outlive
 * them. An invocation pairs its start with its end or error (the `end_*` columns); a
 * single-event invocation (`skill_invoke`, `gateway_invoke`, `gateway_error`, or an end
 * that never saw its start) has no end columns.
 *
 * Search steps keep only the salted `query_hash` and at most 32 hit ids, never the
 * query text. `offered_*` say which earlier search in the turn listed the invoked
 * target (the latest one that did) and at what 1-based rank; `first_search_rank` is
 * its 1-based rank in the turn's first search.
 */
export const traceTurnSteps = pgTable(
  "trace_turn_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    turnId: uuid("turn_id")
      .notNull()
      .references(() => traceTurns.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // 1-based position in the turn.
    ordinal: integer("ordinal").notNull(),
    // "search" | "invoke".
    kind: text("kind").notNull(),
    // The wire type of the `trace_event_id` row (search, skill_search, gateway_search,
    // invoke_start, skill_invoke, gateway_invoke, gateway_error, invoke_end, invoke_error).
    eventType: text("event_type").notNull(),
    traceEventId: uuid("trace_event_id").notNull(),
    endTraceEventId: uuid("end_trace_event_id"),
    // True when the source event carried the envelope's turn_id.
    declared: boolean("declared").notNull().default(false),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    endOccurredAt: timestamp("end_occurred_at", { withTimezone: true }),
    endReceivedAt: timestamp("end_received_at", { withTimezone: true }),
    // Milliseconds since the previous step in the turn (clamped at zero); null for the first.
    gapMs: integer("gap_ms"),
    // Search steps:
    // 1-based among the turn's searches.
    searchOrdinal: integer("search_ordinal"),
    // "search" | "skill_search" | "gateway_search".
    searchType: text("search_type"),
    queryHash: text("query_hash"),
    topK: integer("top_k"),
    hitCount: integer("hit_count"),
    // The first 32 hit ids in rank order, and their scores (null where the SDK sent
    // none). Gateway searches carry a count and no ids.
    hitIds: text("hit_ids").array(),
    hitScores: real("hit_scores").array(),
    // Invoke steps:
    // "tool" | "skill".
    targetType: text("target_type"),
    targetId: text("target_id"),
    invocationId: text("invocation_id"),
    // "ok" | "error" | "unknown" (a start that never saw its end).
    outcome: text("outcome"),
    tookMs: integer("took_ms"),
    offeredByOrdinal: integer("offered_by_ordinal"),
    offeredSearchOrdinal: integer("offered_search_ordinal"),
    offeredRank: integer("offered_rank"),
    firstSearchRank: integer("first_search_rank"),
  },
  (t) => [
    uniqueIndex("trace_turn_steps_turn_ordinal_idx").on(t.turnId, t.ordinal),
    index("trace_turn_steps_project_target_idx").on(t.projectId, t.targetType, t.targetId),
  ],
);

export type TraceTurnRow = typeof traceTurns.$inferSelect;
export type NewTraceTurnRow = typeof traceTurns.$inferInsert;
export type TraceTurnStepRow = typeof traceTurnSteps.$inferSelect;
export type NewTraceTurnStepRow = typeof traceTurnSteps.$inferInsert;
