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
import { toolExplorerRuns } from "@/lib/readings/tool-explorer/schema";

/**
 * The tool crafter's tables: one run per crafting pass and the proposals it drafted. Owned
 * fragment of the upstream schema (ADR-0030): `tool_craft_runs` and `tool_craft_proposals`,
 * the tool-crafter partition of the upstream schema hub. The `craft_tools` queued-job index
 * lives with the `jobs` table (`lib/jobs/schema.ts`).
 *
 * PRIVACY: tool ids and definitions only; a proposal never stores query text, an intent's name
 * or an end-user id.
 */

/**
 * One crafting pass over a project's catalog: the `craft_tools` job writes one row per run,
 * queued after each completed explorer run (`chained`) or by an MCP client (`manual`). The run
 * names the explorer reading it read (`explorer_run_id`, set null when that run goes) and
 * keeps every candidate it weighed (`candidates`), proposed or not, so the page can say why a
 * change was not drafted.
 */
export const toolCraftRuns = pgTable(
  "tool_craft_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // "chained" (after an explorer run) | "manual" (generate_tool_crafts).
    trigger: text("trigger").notNull(),
    // "queued" | "running" | "crafted" | "failed".
    status: text("status").notNull().default("queued"),
    explorerRunId: uuid("explorer_run_id").references(() => toolExplorerRuns.id, {
      onDelete: "set null",
    }),
    candidates: jsonb("candidates").$type<Record<string, unknown>[]>().notNull().default([]),
    proposalsCreated: integer("proposals_created").notNull().default(0),
    declinedReason: text("declined_reason"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("tool_craft_runs_project_created_idx").on(t.projectId, t.createdAt),
    uniqueIndex("tool_craft_runs_project_live_idx")
      .on(t.projectId)
      .where(sql`${t.status} in ('queued', 'running')`),
  ],
);

/**
 * One drafted change to a project's tools: a merge, a fold, a retirement, a tightened schema
 * and the other kinds in `CRAFT_KINDS` (`types.ts`). The sources are frozen on the row
 * (`source_definitions`) so the draft reads the same after the catalog moves on; `crafted`
 * holds the drafted definitions and `hidden_tool_ids` the sources the change retires.
 * `status` is `pending`, `dismissed` or `superseded` (a later run drafted the project again).
 */
export const toolCraftProposals = pgTable(
  "tool_craft_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => toolCraftRuns.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // One of CRAFT_KINDS (lib/synthesis/tool-crafter/types.ts).
    kind: text("kind").notNull(),
    status: text("status").notNull().default("pending"),
    sourceToolIds: text("source_tool_ids").array().notNull(),
    sourceDefinitions: jsonb("source_definitions").$type<Record<string, unknown>[]>().notNull(),
    crafted: jsonb("crafted").$type<Record<string, unknown>[]>().notNull(),
    hiddenToolIds: text("hidden_tool_ids").array().notNull().default([]),
    rationale: text("rationale").notNull(),
    details: text("details").notNull().default(""),
    expectedEffect: text("expected_effect").notNull().default(""),
    migrationNotes: text("migration_notes").notNull().default(""),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    backtest: jsonb("backtest").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("tool_craft_proposals_project_status_idx").on(t.projectId, t.status),
    index("tool_craft_proposals_run_idx").on(t.runId),
  ],
);

export type ToolCraftRunRow = typeof toolCraftRuns.$inferSelect;
export type NewToolCraftRunRow = typeof toolCraftRuns.$inferInsert;
export type ToolCraftProposalRow = typeof toolCraftProposals.$inferSelect;
export type NewToolCraftProposalRow = typeof toolCraftProposals.$inferInsert;
