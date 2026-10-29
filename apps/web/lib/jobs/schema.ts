import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { projects } from "@/lib/platform/projects/schema";

/**
 * The durable job queue (owned fragment of the upstream schema). A route or action inserts a
 * `queued` row and returns; the runner claims rows with `FOR UPDATE SKIP LOCKED`, runs the
 * handler the registry supplies for `kind`, and records the outcome.
 *
 * The partial unique indexes coalesce "at most one queued job of this kind per project": an
 * ingest route enqueues on every accepted batch and relies on `onConflictDoNothing`. A running
 * job does not block a new queued one, so a batch that lands mid-run still gets a follow-up.
 * The kinds are strings owned by higher layers; the indexes live here because they are the
 * table's, and a kind without one simply allows several queued rows. Keep them in step with
 * upstream `lib/db/schema.ts`.
 */
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // A job kind the composition registry knows, e.g. "build_trace_turns" or "cluster_intents".
    kind: text("kind").notNull(),
    // "queued" | "running" | "done" | "error"
    status: text("status").notNull().default("queued"),
    payload: jsonb("payload"),
    result: jsonb("result"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("jobs_project_status_idx").on(t.projectId, t.status),
    index("jobs_status_created_idx").on(t.status, t.createdAt),
    uniqueIndex("jobs_build_trace_turns_queued_idx")
      .on(t.projectId, t.kind)
      .where(sql`${t.status} = 'queued' and ${t.kind} = 'build_trace_turns'`),
    uniqueIndex("jobs_compute_trace_signals_queued_idx")
      .on(t.projectId, t.kind)
      .where(sql`${t.status} = 'queued' and ${t.kind} = 'compute_trace_signals'`),
    uniqueIndex("jobs_label_workflows_queued_idx")
      .on(t.projectId, t.kind)
      .where(sql`${t.status} = 'queued' and ${t.kind} = 'label_workflows'`),
    uniqueIndex("jobs_explore_tool_usage_queued_idx")
      .on(t.projectId, t.kind)
      .where(sql`${t.status} = 'queued' and ${t.kind} = 'explore_tool_usage'`),
    uniqueIndex("jobs_craft_tools_queued_idx")
      .on(t.projectId, t.kind)
      .where(sql`${t.status} = 'queued' and ${t.kind} = 'craft_tools'`),
    uniqueIndex("jobs_fold_intent_graph_queued_idx")
      .on(t.projectId, t.kind)
      .where(sql`${t.status} = 'queued' and ${t.kind} = 'fold_intent_graph'`),
    uniqueIndex("jobs_cluster_intents_queued_idx")
      .on(t.projectId, t.kind)
      .where(sql`${t.status} = 'queued' and ${t.kind} = 'cluster_intents'`),
    // The pacing read on every accepted batch ("did one finish in the last minute?") ranges on
    // finished_at, so it stays bounded as a project's finished runs accrue.
    index("jobs_fold_intent_graph_finished_idx")
      .on(t.projectId, t.finishedAt)
      .where(sql`${t.kind} = 'fold_intent_graph'`),
    index("jobs_cluster_intents_finished_idx")
      .on(t.projectId, t.finishedAt)
      .where(sql`${t.kind} = 'cluster_intents'`),
  ],
);

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type JobStatus = "queued" | "running" | "done" | "error";
