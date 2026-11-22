import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { projects } from "@/lib/platform/projects/schema";
import type { ScorerKind } from "./types";

/**
 * A task's scorers and its daily scores. Owned fragment of the upstream schema (ADR-0030):
 * `task_scorers` and `task_scores_daily`, the task-scorers partition of the upstream schema hub,
 * column for column, because production already has these tables.
 */

/** Scorers for a workflow task. The task id has no separate task table. */
export const taskScorers = pgTable(
  "task_scorers",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    taskId: text("task_id").notNull(),
    kind: text("kind").$type<ScorerKind>().notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    enabled: boolean("enabled").notNull().default(true),
    source: text("source").$type<"default" | "user">().notNull().default("default"),
    version: integer("version").notNull().default(1),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.taskId, t.kind] }),
    check("task_scorers_source_check", sql`${t.source} in ('default', 'user')`),
    check(
      "task_scorers_kind_check",
      sql`${t.kind} in ('ends_well', 'max_self_corrections', 'max_latency_ms', 'max_cost_usd', 'expected_tool', 'max_tool_calls', 'judge_criteria')`,
    ),
    check("task_scorers_version_check", sql`${t.version} > 0`),
  ],
);

/** Daily counts. The overall row uses a non-null kind so reruns have one conflict key. */
export const taskScoresDaily = pgTable(
  "task_scores_daily",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    taskId: text("task_id").notNull(),
    day: date("day").notNull(),
    scorerKind: text("scorer_kind").$type<ScorerKind | "overall">().notNull(),
    scorerVersion: integer("scorer_version").notNull(),
    judgeSpend: jsonb("judge_spend").$type<{ usd: number; runIds: string[]; reserved?: boolean }>(),
    n: integer("n").notNull(),
    passed: integer("passed").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.taskId, t.day, t.scorerKind] }),
    check(
      "task_scores_daily_kind_check",
      sql`${t.scorerKind} in ('overall', 'ends_well', 'max_self_corrections', 'max_latency_ms', 'max_cost_usd', 'expected_tool', 'max_tool_calls', 'judge_criteria')`,
    ),
    check(
      "task_scores_daily_counts_check",
      sql`${t.n} >= 0 and ${t.passed} >= 0 and ${t.passed} <= ${t.n}`,
    ),
    check("task_scores_daily_version_check", sql`${t.scorerVersion} > 0`),
  ],
);

export type TaskScorerRow = typeof taskScorers.$inferSelect;
export type TaskScoreDailyRow = typeof taskScoresDaily.$inferSelect;
