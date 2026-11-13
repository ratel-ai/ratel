import {
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

/** Catalog snapshots a runtime pushes, and their tool definitions. Owned fragment of the upstream schema (ADR-0030). */

/** Content-addressed receipt metadata for each source's latest full catalog. */
export const catalogSnapshots = pgTable(
  "catalog_snapshots",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sourceId: text("source_id").notNull(),
    contentHash: text("content_hash").notNull(),
    toolCount: integer("tool_count").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.sourceId] }),
    index("catalog_snapshots_project_received_idx").on(t.projectId, t.receivedAt),
  ],
);

/** Current full-snapshot tool definitions, replaced atomically per source. */
export const catalogToolDefinitions = pgTable(
  "catalog_tool_definitions",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sourceId: text("source_id").notNull(),
    toolId: text("tool_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    // Null when the publisher matches on `description`. Kept here as well as on
    // `runtime_catalog_entries` because that table is keyed per entry, not per
    // source: two sources publishing the same tool id collapse into one row
    // there, and this is the only place each source's own text survives.
    searchableDescription: text("searchable_description"),
    inputSchema: jsonb("input_schema").$type<Record<string, unknown>>(),
    outputSchema: jsonb("output_schema").$type<Record<string, unknown>>(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.sourceId, t.toolId] }),
    index("catalog_tool_definitions_project_name_idx").on(t.projectId, t.name),
  ],
);

export type CatalogSnapshotRow = typeof catalogSnapshots.$inferSelect;
export type NewCatalogSnapshotRow = typeof catalogSnapshots.$inferInsert;
export type CatalogToolDefinition = typeof catalogToolDefinitions.$inferSelect;
export type NewCatalogToolDefinition = typeof catalogToolDefinitions.$inferInsert;
