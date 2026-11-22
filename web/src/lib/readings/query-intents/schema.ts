import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { traceEvents } from "@/lib/ingest/trace-events/schema";
import { projects } from "@/lib/platform/projects/schema";

/**
 * Recurring asks: the canonical query intents a project's search queries are categorized
 * into, and the per-occurrence ledger behind them. Owned fragment of the upstream schema
 * (ADR-0030).
 *
 * `occurrences` and `last_seen_at` are recomputed from the ledger by
 * `recordQueryIntentOccurrences`, never incremented, so a retried or overlapping run
 * lands on the same true count. `text` is the first-seen (or clustered) representative
 * display form; `member_text` is the cluster's accumulated vocabulary the BM25 clusterer
 * matches on.
 */
export const queryIntents = pgTable(
  "query_intents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    normalizedText: text("normalized_text").notNull(),
    text: text("text").notNull(),
    // Default 0, NOT 1: the row is created and bumped as two separate steps, so a fresh
    // row always gets bumped by its batch's true occurrence count right after.
    occurrences: integer("occurrences").notNull().default(0),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    // Newline-joined, distinct phrases this canonical has absorbed, capped by
    // `member-text.ts`. Never used for exact match, so it carries no dedup semantics.
    memberText: text("member_text").notNull().default(""),
  },
  (t) => [
    uniqueIndex("query_intents_project_normalized_idx").on(t.projectId, t.normalizedText),
    index("query_intents_project_occurrences_idx").on(t.projectId, t.occurrences),
    index("query_intents_project_last_seen_idx").on(t.projectId, t.lastSeenAt),
  ],
);

/**
 * One row per canonical ask a `trace_events` search event was categorized into.
 * `(trace_event_id, intent_index)` is the idempotency key: a run windows by the
 * project's watermark, so the same event can be re-read by two overlapping runs, and
 * `ON CONFLICT DO NOTHING` makes the repeat a no-op.
 */
export const queryIntentOccurrences = pgTable(
  "query_intent_occurrences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    queryIntentId: uuid("query_intent_id")
      .notNull()
      .references(() => queryIntents.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // The source event this occurrence was categorized from (provenance + idempotency).
    traceEventId: uuid("trace_event_id")
      .notNull()
      .references(() => traceEvents.id, { onDelete: "cascade" }),
    // Which intent of the source event this row is (0-based, always 0 today).
    intentIndex: integer("intent_index").notNull().default(0),
    // Denormalized from the source event, so a reader never joins back for the raw phrasing.
    query: text("query").notNull(),
    sessionId: text("session_id"),
    endUserId: text("end_user_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("query_intent_occurrences_trace_event_idx").on(t.traceEventId, t.intentIndex),
    index("query_intent_occurrences_query_intent_idx").on(t.queryIntentId),
  ],
);

export type QueryIntent = typeof queryIntents.$inferSelect;
export type NewQueryIntent = typeof queryIntents.$inferInsert;
export type QueryIntentOccurrence = typeof queryIntentOccurrences.$inferSelect;
export type NewQueryIntentOccurrence = typeof queryIntentOccurrences.$inferInsert;
