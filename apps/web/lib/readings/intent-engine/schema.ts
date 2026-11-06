import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { traceEvents } from "@/lib/ingest/trace-events/schema";
import { projects } from "@/lib/platform/projects/schema";
import type {
  AskKind,
  CapabilityEdges,
  SourceSlice,
} from "@/lib/readings/intent-types/engine-types";
import { queryIntents } from "@/lib/readings/query-intents/schema";

/**
 * The intent engine: the lexical clustering of every ask a project's agents received,
 * at three levels, with its cursor and the assignment of each ask to a cluster. Owned
 * fragment of the upstream schema (ADR-0030). The engine keeps its own cursor, separate
 * from the intent-graph fold's, so it runs beside the fold without moving it.
 */
export const intentEngineState = pgTable("intent_engine_state", {
  projectId: uuid("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  // Latest trace_events.received_at clustered; read as text to keep microseconds.
  clusteredThrough: timestamp("clustered_through", { withTimezone: true }),
  // Next `intent_N` the engine hands out (merged graph and per-source alike).
  nextGraphN: integer("next_graph_n").notNull().default(0),
  // When the first run seeded clusters from the stored graphs and query intents.
  seededAt: timestamp("seeded_at", { withTimezone: true }),
  // When the model last named clusters for this project: naming runs at most once an
  // hour, so a busy project's spend stays bounded.
  namedAt: timestamp("named_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The engine's clusters, every level in one table. Level 0 rows are the clusters asks
 * land in ("Ways people ask it"; wire id `graph_id`, `intent_N`); level 1 is one action
 * on one thing ("What they ask for"); level 2 (domains) stays internal. Levels above 0
 * are rebuilt after each run, ids kept by child overlap. `parent_id` points one level
 * up. `query_intent_id` links a level-0 cluster to the recurring-asks row it was seeded
 * from.
 *
 * PRIVACY: `members` / `served_members` are raw ask text (what users and agents asked,
 * never an assistant's reply), capped at the 50 newest per cluster. Never log them.
 */
export const intentClusters = pgTable(
  "intent_clusters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    level: integer("level").notNull().default(0),
    parentId: uuid("parent_id"),
    graphId: text("graph_id"),
    label: text("label").notNull().default(""),
    terms: jsonb("terms").$type<string[]>().notNull().default([]),
    // Level 0: every ask text that joined, any kind; the match key. Capped.
    members: jsonb("members").$type<string[]>().notNull().default([]),
    // Level 0: confirmed search and prompt texts, what a runtime would be served. Capped.
    servedMembers: jsonb("served_members").$type<string[]>().notNull().default([]),
    // Level 1+: the uuids one level down.
    children: jsonb("children").$type<string[]>().notNull().default([]),
    support: integer("support").notNull().default(0),
    asks: integer("asks").notNull().default(0),
    // The learner's edges and surfaced counts.
    edges: jsonb("edges").$type<CapabilityEdges>().notNull().default({ tools: {}, skills: {} }),
    // `tool:x` / `skill:x` -> asks whose turn ran it, any ask kind. Matching evidence only.
    usage: jsonb("usage").$type<Record<string, number>>().notNull().default({}),
    // Per runtime source: that source's own slice.
    sources: jsonb("sources").$type<Record<string, SourceSlice>>().notNull().default({}),
    firstTs: bigint("first_ts", { mode: "number" }),
    lastTs: bigint("last_ts", { mode: "number" }),
    queryIntentId: uuid("query_intent_id").references(() => queryIntents.id, {
      onDelete: "set null",
    }),
    // Levels 0 and 1: a model-written name and the hash of the phrases it was written
    // from (`names.ts`). A changed hash asks for a new name.
    llmLabel: text("llm_label"),
    llmLabelHash: text("llm_label_hash"),
    // Level 0, with model keys on: the model's action class and object, under the same hash.
    llmAction: text("llm_action"),
    llmObject: text("llm_object"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // A run loads the project's most recently active level-0 clusters, at most a bounded
    // number, newest first: never every row with its members.
    index("intent_clusters_project_level_last_idx").on(
      t.projectId,
      t.level,
      t.lastTs.desc().nullsLast(),
    ),
    index("intent_clusters_project_parent_idx").on(t.projectId, t.parentId),
    index("intent_clusters_query_intent_idx").on(t.queryIntentId),
  ],
);

/**
 * Which level-0 cluster each ask landed in. One row per ask, or per part of an ask that
 * held several requests (`ask_index`). Cascades with its trace event. Carries the trace,
 * session and turn so the Intents breakdown places an ask in its Agent health turn
 * without the raw event. No text.
 */
export const intentClusterAssignments = pgTable(
  "intent_cluster_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    traceEventId: uuid("trace_event_id")
      .notNull()
      .references(() => traceEvents.id, { onDelete: "cascade" }),
    askIndex: integer("ask_index").notNull().default(0),
    clusterId: uuid("cluster_id").notNull(),
    // "user_message" | "prompt" | "search".
    kind: text("kind").$type<AskKind>().notNull(),
    sessionId: text("session_id"),
    turnId: text("turn_id"),
    traceId: text("trace_id"),
    sourceId: text("source_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // A search step's asks, by its event: the breakdown's join from a turn's steps.
    uniqueIndex("intent_cluster_assignments_event_idx").on(t.traceEventId, t.askIndex),
    index("intent_cluster_assignments_cluster_idx").on(t.projectId, t.clusterId),
    // An OTLP turn's prompts, by its trace.
    index("intent_cluster_assignments_trace_idx")
      .on(t.projectId, t.traceId)
      .where(sql`${t.traceId} is not null`),
    // A declared turn's user message, by session and turn id.
    index("intent_cluster_assignments_turn_idx")
      .on(t.projectId, t.sessionId, t.turnId)
      .where(sql`${t.turnId} is not null`),
  ],
);

export type IntentClusterRow = typeof intentClusters.$inferSelect;
export type IntentClusterAssignmentRow = typeof intentClusterAssignments.$inferSelect;
