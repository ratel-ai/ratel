import { sql } from "drizzle-orm";
import {
  boolean,
  check,
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

/**
 * Session replay's What-if tables. Owned fragment of the upstream schema (ADR-0030):
 * `session_replay_settings` and `session_replay_runs`, the session-replay partition of the
 * upstream schema hub, column for column.
 */

/**
 * Session replay settings per project (RC-176). `read_content` is the opt-in
 * that lets a What-if run read captured prompts to replay the model; off, a
 * run re-ranks only.
 */
export const sessionReplaySettings = pgTable("session_replay_settings", {
  projectId: uuid("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  readContent: boolean("read_content").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SessionReplaySettingsRow = typeof sessionReplaySettings.$inferSelect;

/**
 * One What-if run (RC-176): model call `step` of a run forked with one
 * variant and sampled k times per side. Only numbers, tool names and codes:
 * the variant's definitions travel in the job's payload, never here. Pruned
 * after 30 days.
 */
export const sessionReplayRuns = pgTable(
  "session_replay_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull(),
    turnId: uuid("turn_id").notNull(),
    step: integer("step").notNull(),
    /** The variant's kind and the row it came from (a fix id, a proposal id, a catalog entry, a tool name). */
    variantKind: text("variant_kind").notNull(),
    variantRef: text("variant_ref"),
    variantKey: text("variant_key").notNull(),
    /** `replay` (the model, with the content opt-in) or `rerank`. */
    method: text("method").notNull(),
    k: integer("k").notNull(),
    model: text("model"),
    recordedTool: text("recorded_tool"),
    beforeTool: text("before_tool"),
    afterTool: text("after_tool"),
    /** `{ before: { tool: count }, after: { tool: count } }`. */
    distribution: jsonb("distribution").$type<{
      before: Record<string, number>;
      after: Record<string, number>;
    }>(),
    /** `{ before: { input, output }, after: { input, output } }`. */
    tokens: jsonb("tokens").$type<{
      before: { input: number; output: number };
      after: { input: number; output: number };
    }>(),
    /** What the run spent (or holds while it is live): counted in the organization's daily budget. */
    spend: jsonb("spend").$type<{ usd: number; reserved: boolean; capUsd: number }>().notNull(),
    status: text("status").notNull().default("queued"),
    /** A short code-like reason when it failed or could not simulate. */
    errorCode: text("error_code"),
    requestedBy: text("requested_by").notNull(),
    jobId: uuid("job_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("session_replay_runs_live_idx")
      .on(t.projectId, t.turnId, t.step, t.variantKey)
      .where(sql`${t.status} in ('queued', 'running')`),
    index("session_replay_runs_project_created_idx").on(t.projectId, t.createdAt),
    index("session_replay_runs_created_idx").on(t.createdAt),
    check(
      "session_replay_runs_status_check",
      sql`${t.status} in ('queued', 'running', 'completed', 'failed')`,
    ),
    check("session_replay_runs_method_check", sql`${t.method} in ('replay', 'rerank')`),
    check("session_replay_runs_k_check", sql`${t.k} between 1 and 10`),
  ],
);

export type SessionReplayRunRow = typeof sessionReplayRuns.$inferSelect;
