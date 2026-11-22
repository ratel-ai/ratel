import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { projects } from "@/lib/platform/projects/schema";

/** The skills catalog and the tool definitions it publishes. Owned fragment of the upstream schema (ADR-0030). */

/**
 * A project's managed skill catalog — the source of truth the `protocol/v1`
 * pull-sync (`GET /v1/catalog`, ADR-0003) serves. One row per skill; `name` is the
 * kebab-case id, unique among a project's non-archived rows (the wire's uniqueness
 * invariant). `tools` and `metadata` carry the wire shape directly. On top of the
 * wire fields Cloud owns a lifecycle: `status` (draft → published → archived) and
 * a per-skill `version` for optimistic concurrency, so two concurrent writers (the
 * dashboard, the API, MCP) can't silently clobber each other (edits compare-and-swap
 * on `WHERE version = expected`). Only *published, global* rows are served by the
 * sync endpoint; the content-hash of that set lives on `projects.catalog_version`
 * (the ETag). Independent of the telemetry tables.
 */
export const skills = pgTable(
  "skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // kebab-case skill id / folder name; unique among a project's non-archived skills.
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    // Null means retrieval uses description. An explicit string (including
    // empty) replaces only the searchable description component in protocol/v2.
    searchableDescription: text("searchable_description"),
    tags: jsonb("tags").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    // Client-owned tool ids this skill's instructions call (protocol/v1 `tools`).
    tools: jsonb("tools").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    // Free-form non-indexed labels (protocol/v1 `metadata`: { key: string[] }).
    metadata: jsonb("metadata")
      .$type<Record<string, string[]>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    // The SKILL.md markdown body (frontmatter excluded).
    body: text("body").notNull().default(""),
    // "draft" | "published" | "archived" — the catalog lifecycle.
    status: text("status").notNull().default("draft"),
    // Optimistic-concurrency guard: bumped on every edit/publish/archive. Edits
    // compare-and-swap on the expected version so concurrent writers can't clobber.
    version: integer("version").notNull().default(1),
    // Scope: NULL = global (project-wide); set = tailored to one opaque SDK end-user
    // (NOT a FK, same id space as trace_events.end_user_id). Set by the create/edit
    // inputs (settable on create, re-scopeable/clearable on edit). Name uniqueness
    // deliberately stays project-wide regardless of scope (no shadowing); a
    // colliding create gets a name conflict. Sync serves global rows only until the
    // SDK can identify its end-user.
    endUserId: text("end_user_id"),
    // The model that drafted this skill, when it was machine-generated.
    model: text("model"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (t) => [
    // A project's skill names are unique among non-archived rows — so an archived
    // skill and a new live one can share a name, but two live ones can't.
    uniqueIndex("skills_project_name_active_idx")
      .on(t.projectId, t.name)
      .where(sql`${t.status} <> 'archived'`),
    // The sync/list scan: a project's skills by status (the published set, drafts, …).
    index("skills_project_status_idx").on(t.projectId, t.status),
  ],
);

/**
 * What a project's tools ARE, as opposed to how often they were called.
 *
 * `listObservedTools` recovers tool names from telemetry, which is enough to
 * bill and chart them but not to explain them: a name alone is not what
 * retrieval matches on. Without a description a tool is unrankable, so the
 * Playground would show it as permanently unretrievable and the tools catalog
 * as a list of bare identifiers.
 *
 * These rows are the definitions themselves, keyed by the same `name` the
 * telemetry reports so the two join. Cloud does not own them: they belong to
 * whoever runs the agent, and the write path is a sync from that side (today,
 * the demo seeder). Nothing in the UI edits this table, which is why the
 * Playground's tool edits stay explicitly hypothetical.
 */
export const toolDefinitions = pgTable(
  "tool_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // Joins to the keys of event_metrics.tools_by_name. NOT a FK: telemetry can
    // report a tool that was never synced, and a sync can describe a tool that
    // has not been called yet. Both are real states worth showing.
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    // JSON Schema for the tool's arguments, as the client declared it.
    parameters: jsonb("parameters").$type<Record<string, unknown> | null>(),
    // Where the definition came from, so a synced row is distinguishable from
    // a seeded one when real sync lands beside the demo data.
    source: text("source").notNull().default("sync"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One definition per tool name per project; a re-sync upserts on this.
    uniqueIndex("tool_definitions_project_name_idx").on(t.projectId, t.name),
  ],
);

export type Skill = typeof skills.$inferSelect;
export type NewSkill = typeof skills.$inferInsert;
