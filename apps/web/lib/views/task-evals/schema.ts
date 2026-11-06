import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { projects } from "@/lib/platform/projects/schema";

/**
 * A task's eval set. Owned fragment of the upstream schema (ADR-0030): `task_eval_sets` and
 * `task_eval_cases`, the task-evals partition of the upstream schema hub, column for column,
 * because production already has these tables.
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
