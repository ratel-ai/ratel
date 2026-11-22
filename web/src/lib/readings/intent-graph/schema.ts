import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { projects } from "@/lib/platform/projects/schema";
import type {
  IntentGraphDocument,
  IntentGraphEdgeKind,
  IntentGraphProducer,
} from "@/lib/readings/intent-types/wire";

/**
 * The intent graph: what a runtime learned about which asks lead to which tools, pushed
 * by the SDK or folded here from stored events, with its read projections and history.
 * Owned fragment of the upstream schema (ADR-0030). `intent_graph_runtime_status`, the
 * per-source ranking status ingest upserts, lives with ingest.
 *
 * `intent_graphs` is state, not a log: retention never prunes it. Cluster `members`
 * inside the document are raw user query text and follow the same access rules as trace
 * events; never log them.
 */
export const intentGraphs = pgTable(
  "intent_graphs",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    graphKey: text("graph_key").notNull(),
    producer: text("producer").$type<IntentGraphProducer>().notNull(),
    document: jsonb("document").$type<IntentGraphDocument>().notNull(),
    rev: bigint("rev", { mode: "number" }).notNull(),
    schemaVersion: integer("schema_version").notNull(),
    // Embedding-model fingerprint when the graph carries centroids; null for a
    // lexically clustered graph.
    model: text("model"),
    builtFromTs: timestamp("built_from_ts", { withTimezone: true }).notNull(),
    clusterCount: integer("cluster_count").notNull(),
    byteSize: integer("byte_size").notNull(),
    // sha256 over the canonical document without `rev`; served as the ETag.
    contentHash: text("content_hash").notNull(),
    // Last accepted write, including an "unchanged" resave (receipt).
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    // Last write that changed the document.
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // Last time a runtime fetched *this* graph (GET). Null until the first pull.
    pulledAt: timestamp("pulled_at", { withTimezone: true }),
    // Since when a runtime has ranked from this graph; null while none does. Derived
    // from `usage_ranking_status` events: going live happens in the customer's code.
    liveAt: timestamp("live_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.graphKey] }),
    index("intent_graphs_project_updated_idx").on(t.projectId, t.updatedAt),
  ],
);

/**
 * History of accepted graph writes, one row per stored revision. The drain keeps the
 * newest `INTENT_GRAPH_REVISIONS_KEPT` per key and never removes the revision the
 * current `intent_graphs` row points at. Read by the timeline; never by the runtime.
 */
export const intentGraphRevisions = pgTable(
  "intent_graph_revisions",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    graphKey: text("graph_key").notNull(),
    rev: bigint("rev", { mode: "number" }).notNull(),
    document: jsonb("document").$type<IntentGraphDocument>().notNull(),
    contentHash: text("content_hash").notNull(),
    clusterCount: integer("cluster_count").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.graphKey, t.rev] }),
    index("intent_graph_revisions_project_key_received_idx").on(
      t.projectId,
      t.graphKey,
      t.receivedAt,
    ),
  ],
);

/**
 * Read projection of `intent_graphs.document`: one row per cluster, rebuilt in the same
 * transaction as every graph write. `label_override` is a console-chosen display name;
 * the runtime rewrites `label` from members on every save. `members` is raw user query text.
 */
export const intentGraphClusters = pgTable(
  "intent_graph_clusters",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    graphKey: text("graph_key").notNull(),
    clusterId: text("cluster_id").notNull(),
    label: text("label").notNull(),
    labelOverride: text("label_override"),
    terms: jsonb("terms").$type<string[]>().notNull().default([]),
    members: jsonb("members").$type<string[]>().notNull().default([]),
    memberCount: integer("member_count").notNull(),
    support: integer("support").notNull(),
    seededSupport: integer("seeded_support").notNull().default(0),
    lastTs: timestamp("last_ts", { withTimezone: true }),
    hasCentroid: boolean("has_centroid").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.graphKey, t.clusterId] }),
    index("intent_graph_clusters_project_key_support_idx").on(t.projectId, t.graphKey, t.support),
  ],
);

/**
 * Read projection of a cluster's `tools` and `skills` edge maps: one row per (cluster,
 * kind, capability). The capability index serves the tool-centric view.
 */
export const intentGraphEdges = pgTable(
  "intent_graph_edges",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    graphKey: text("graph_key").notNull(),
    clusterId: text("cluster_id").notNull(),
    kind: text("kind").$type<IntentGraphEdgeKind>().notNull(),
    capabilityId: text("capability_id").notNull(),
    // Confirmed invocation count. Only its order within a cluster is load-bearing.
    weight: doublePrecision("weight").notNull(),
    // Times this capability was ranked at or above the one the agent picked on a turn in
    // this cluster, without being picked. Null for a graph written before the runtime
    // recorded impressions.
    surfaced: integer("surfaced"),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.graphKey, t.clusterId, t.kind, t.capabilityId] }),
    index("intent_graph_edges_capability_idx").on(t.projectId, t.kind, t.capabilityId),
  ],
);

/**
 * The with-and-without comparison, one row per stored search per folded graph: while
 * folding a search, the query is ranked plainly and with the graph as it stood before,
 * and the invoked tool is filled in when the turn's invoke is folded. An estimate: the
 * replay is lexical, whatever the runtime uses.
 */
export const intentGraphShadowTurns = pgTable(
  "intent_graph_shadow_turns",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    graphKey: text("graph_key").notNull(),
    // The `trace_events.id` of the search this row replays.
    searchEventId: uuid("search_event_id").notNull(),
    sourceId: text("source_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    plainIds: jsonb("plain_ids").$type<string[]>().notNull(),
    boostedIds: jsonb("boosted_ids").$type<string[]>().notNull(),
    // Whether a cluster matched the query and the boost was armed.
    matched: boolean("matched").notNull().default(false),
    // Whether the graph was live when the search was folded.
    live: boolean("live").notNull().default(false),
    // Whether the two lists are the runtime's own report rather than the replay.
    reported: boolean("reported").notNull().default(false),
    invokedToolId: text("invoked_tool_id"),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.graphKey, t.searchEventId] }),
    index("intent_graph_shadow_turns_graph_time_idx").on(t.projectId, t.graphKey, t.occurredAt),
  ],
);

export type IntentGraphRow = typeof intentGraphs.$inferSelect;
export type NewIntentGraphRow = typeof intentGraphs.$inferInsert;
export type IntentGraphRevisionRow = typeof intentGraphRevisions.$inferSelect;
export type NewIntentGraphRevisionRow = typeof intentGraphRevisions.$inferInsert;
export type IntentGraphClusterRow = typeof intentGraphClusters.$inferSelect;
export type NewIntentGraphClusterRow = typeof intentGraphClusters.$inferInsert;
export type IntentGraphEdgeRow = typeof intentGraphEdges.$inferSelect;
export type NewIntentGraphEdgeRow = typeof intentGraphEdges.$inferInsert;
export type IntentGraphShadowTurnRow = typeof intentGraphShadowTurns.$inferSelect;
