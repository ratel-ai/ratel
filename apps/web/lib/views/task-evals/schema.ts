import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { projects } from "@/lib/platform/projects/schema";
import { fixShipments } from "@/lib/views/fixes/schema";

/**
 * A task's eval set and the runs over it. Owned fragment of the upstream schema (ADR-0030):
 * `task_eval_sets`, `task_eval_cases` and `task_eval_runs`, the task-evals partition of the
 * upstream schema hub, column for column, because production already has these tables.
 */

/** Each workflow task has one eval set. Refreshes use the current scorer engine. */
export const taskEvalSets = pgTable(
  "task_eval_sets",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    taskId: text("task_id").notNull(),
    targetRuns: integer("target_runs").notNull().default(20),
    scorerVersion: integer("scorer_version").notNull(),
    refreshedAt: timestamp("refreshed_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.taskId] }),
    check("task_eval_sets_target_check", sql`${t.targetRuns} between 1 and 200`),
    check("task_eval_sets_version_check", sql`${t.scorerVersion} > 0`),
  ],
);

/** Excluded rows retain the exclusion so later refreshes cannot select the run again. */
export const taskEvalCases = pgTable(
  "task_eval_cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    taskId: text("task_id").notNull(),
    turnId: uuid("turn_id").notNull(),
    origin: text("origin").$type<"auto" | "issue" | "user" | "fix">().notNull(),
    fixId: text("fix_id"),
    pinned: boolean("pinned").notNull().default(false),
    excludedAt: timestamp("excluded_at", { withTimezone: true }),
    expected: jsonb("expected").$type<Record<string, unknown>>().notNull().default({}),
    criteria: text("criteria").notNull().default(""),
    selectionReason: text("selection_reason").notNull().default(""),
    testName: text("test_name"),
    testAsk: text("test_ask"),
  },
  (t) => [
    foreignKey({
      columns: [t.projectId, t.taskId],
      foreignColumns: [taskEvalSets.projectId, taskEvalSets.taskId],
    }).onDelete("cascade"),
    unique("task_eval_cases_project_task_fix_turn_key")
      .on(t.projectId, t.taskId, t.fixId, t.turnId)
      .nullsNotDistinct(),
    check("task_eval_cases_origin_check", sql`${t.origin} in ('auto', 'issue', 'user', 'fix')`),
    check("task_eval_cases_fix_check", sql`(${t.origin} = 'fix') = (${t.fixId} is not null)`),
  ],
);

export type TaskEvalSetRow = typeof taskEvalSets.$inferSelect;
export type TaskEvalCaseRow = typeof taskEvalCases.$inferSelect;

/** One fix simulation or post-shipment measurement for one task. */
export const taskEvalRuns = pgTable(
  "task_eval_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    fixId: text("fix_id").notNull(),
    taskId: text("task_id").notNull(),
    kind: text("kind").$type<"simulation" | "post_ship">().notNull().default("simulation"),
    shipmentId: uuid("shipment_id").references(() => fixShipments.id, { onDelete: "cascade" }),
    scorerVersion: integer("scorer_version").notNull(),
    status: text("status")
      .$type<"queued" | "running" | "completed" | "failed">()
      .notNull()
      .default("queued"),
    trigger: text("trigger").notNull().default("manual"),
    before: jsonb("before").$type<Record<string, unknown>>(),
    after: jsonb("after").$type<Record<string, unknown>>(),
    results: jsonb("results").$type<Record<string, unknown>[]>(),
    breakdown: jsonb("breakdown").$type<Record<string, unknown>>(),
    methods: jsonb("methods").$type<Record<string, unknown>>(),
    spend: jsonb("spend").$type<Record<string, unknown>>(),
    judge: jsonb("judge").$type<Record<string, unknown>>(),
    change: jsonb("change").$type<Record<string, unknown>>(),
    verdict: text("verdict"),
    error: text("error"),
    caseCount: integer("case_count").notNull().default(0),
    fixCaseCount: integer("fix_case_count").notNull().default(0),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("task_eval_runs_task_created_idx").on(t.projectId, t.taskId, t.createdAt),
    index("task_eval_runs_fix_created_idx").on(t.projectId, t.fixId, t.createdAt),
    uniqueIndex("task_eval_runs_live_idx")
      .on(t.projectId, t.fixId, t.taskId, t.kind)
      .where(sql`${t.status} in ('queued', 'running')`),
    check("task_eval_runs_kind_check", sql`${t.kind} in ('simulation', 'post_ship')`),
    check(
      "task_eval_runs_status_check",
      sql`${t.status} in ('queued', 'running', 'completed', 'failed')`,
    ),
    check("task_eval_runs_counts_check", sql`${t.caseCount} >= 0 and ${t.fixCaseCount} >= 0`),
    check("task_eval_runs_version_check", sql`${t.scorerVersion} > 0`),
  ],
);

export type TaskEvalRunRow = typeof taskEvalRuns.$inferSelect;
