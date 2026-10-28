import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "@/lib/platform/identity/schema";

/**
 * A project is one agent: the unit telemetry is ingested under, catalogs are published for,
 * and API keys authenticate to (ADR-0030, owned fragment of the upstream schema). The cursor
 * columns are advanced by the reading jobs of higher layers; they live on the project row so
 * one row locks one project's folds.
 */
export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    // Content hash of this project's published skills catalog: the sync endpoint's ETag
    // (protocol/v1). Null until the first publish (read as the empty-catalog hash).
    catalogVersion: text("catalog_version"),
    // Protocol/v2 hashes the same published set with searchable_description in its frozen
    // projection; kept apart so v1 conditional GETs stay stable.
    catalogVersionV2: text("catalog_version_v2"),
    // Last time a runtime fetched this project's catalog overrides, the only positive evidence
    // that an override stored here reaches a runtime.
    overridesPulledAt: timestamp("overrides_pulled_at", { withTimezone: true }),
    // Last time a runtime fetched an intent graph for this project (GET /api/v1/intent-graph).
    intentGraphPulledAt: timestamp("intent_graph_pulled_at", { withTimezone: true }),
    // Query-intents watermark: the latest trace event time already folded into query_intents.
    queryIntentsCategorizedThrough: timestamp("query_intents_categorized_through", {
      withTimezone: true,
    }),
    // Intent-graph fold cursor: the latest trace_events.received_at already folded into the
    // built intent graph. Keyed on received_at so a cursor never splits an ingest batch.
    intentGraphFoldedThrough: timestamp("intent_graph_folded_through", { withTimezone: true }),
    // Sample project: seeded, fabricated telemetry so a new account has something to read.
    // Every surface that shows its numbers says so.
    isDemo: boolean("is_demo").notNull().default(false),
    // Turn-ledger cursor: the latest trace_events.received_at already folded into trace_turns.
    traceTurnsBuiltThrough: timestamp("trace_turns_built_through", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("projects_organization_slug_idx").on(t.organizationId, t.slug)],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name"),
    // SHA-256 of the issued key; the ingest endpoints look the key up by it.
    keyHash: text("key_hash").notNull(),
    // Human-recognizable prefix (e.g. "rtl_live_ab12") shown in the console.
    keyPrefix: text("key_prefix").notNull(),
    // No plaintext column: a key is shown once, at creation, and only its hash and prefix are
    // stored, so a database dump or a read replica never holds a working key. Upstream kept
    // the plaintext for a "reveal" affordance; here the settings page offers "regenerate".
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    // Optional expiry. Null = never expires. The shared auth path rejects a key once this
    // instant has passed.
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("api_keys_key_hash_idx").on(t.keyHash),
    index("api_keys_project_id_idx").on(t.projectId),
  ],
);

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
