import {
  boolean,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { projects } from "@/lib/platform/projects/schema";

/** The runtime catalog: every tool and skill a project's runtimes register. Owned fragment of the upstream schema (ADR-0030). */

/** Latest content-addressed definition observed for each runtime catalog entry. */
export const runtimeCatalogEntries = pgTable(
  "runtime_catalog_entries",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    entryId: text("entry_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    inputSchema: jsonb("input_schema").$type<unknown>(),
    outputSchema: jsonb("output_schema").$type<unknown>(),
    searchableDescription: text("searchable_description").notNull(),
    searchableDescriptionOverridden: boolean("searchable_description_overridden").notNull(),
    useCloudDefinitions: boolean("use_cloud_definitions").notNull().default(false),
    provenance: text("provenance").notNull().default("events"),
    // Cloud-side operator replacement. Runtime re-ingest deliberately never
    // updates this column, so the local choice remains authoritative.
    searchableDescriptionOverride: text("searchable_description_override"),
    contentHash: text("content_hash").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.kind, t.entryId] }),
    index("runtime_catalog_entries_project_kind_name_idx").on(t.projectId, t.kind, t.name),
  ],
);

export type RuntimeCatalogEntry = typeof runtimeCatalogEntries.$inferSelect;
export type NewRuntimeCatalogEntry = typeof runtimeCatalogEntries.$inferInsert;
