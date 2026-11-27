import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { projects } from "@/lib/platform/projects/schema";
import type {
  CheckConfig,
  JudgeConfig,
  PresetConfig,
  ScorerFilter,
  ScorerKind,
  ScorerScope,
} from "./types";

/** A project's scorers. Each row carries its own sweep cursor, so a new scorer starts at "now". */
export const traceScorers = pgTable(
  "trace_scorers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").$type<ScorerKind>().notNull(),
    config: jsonb("config").$type<CheckConfig | JudgeConfig | PresetConfig>().notNull(),
    filter: jsonb("filter").$type<ScorerFilter>().notNull().default({}),
    // `tasks`: only the traces of its `trace_scorer_tasks`. Without one left, it scores nothing.
    scope: text("scope").$type<ScorerScope>().notNull().default("all"),
    sampleRate: integer("sample_rate").notNull().default(100),
    enabled: boolean("enabled").notNull().default(true),
    // The last `(updated_at, trace_id)` of `otel_trace_summaries` the sweep read for this scorer.
    // A string, not a Date: a Date keeps milliseconds and `updated_at` has microseconds.
    cursorAt: timestamp("cursor_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    cursorTraceId: text("cursor_trace_id").notNull().default(""),
    // Judge only: how often the batch after the cursor was asked without any answer, and when it is
    // asked again.
    judgeAttempts: integer("judge_attempts").notNull().default(0),
    judgeRetryAt: timestamp("judge_retry_at", { withTimezone: true }),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("trace_scorers_project_idx").on(t.projectId, t.createdAt),
    index("trace_scorers_enabled_idx").on(t.cursorAt).where(sql`${t.enabled}`),
    check("trace_scorers_kind_check", sql`${t.kind} in ('check', 'judge', 'preset')`),
    check("trace_scorers_scope_check", sql`${t.scope} in ('all', 'tasks')`),
    check("trace_scorers_sample_rate_check", sql`${t.sampleRate} between 1 and 100`),
  ],
);

/** Which tasks a scorer of scope `tasks` is attached to: by scorer (the key), and by task (the index). */
export const traceScorerTasks = pgTable(
  "trace_scorer_tasks",
  {
    scorerId: uuid("scorer_id")
      .notNull()
      .references(() => traceScorers.id, { onDelete: "cascade" }),
    // `trace_turns.workflow_id`. Not a foreign key: a signal run may drop a task and find it again.
    taskId: text("task_id").notNull(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.scorerId, t.taskId] }),
    index("trace_scorer_tasks_project_task_idx").on(t.projectId, t.taskId),
  ],
);

/**
 * What of a task's scorers was already given to the one model, so it is given once: each kind that
 * migration 0055 converted or `task-presets.ts` created, and `*` when the task got its defaults. A
 * preset a person detaches or deletes then does not come back.
 */
export const taskPresetSeeds = pgTable(
  "task_preset_seeds",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // `trace_turns.workflow_id`.
    taskId: text("task_id").notNull(),
    // A task kind (`task-scorers/types.ts`), or `*`: the task got its defaults.
    kind: text("kind").notNull(),
    seededAt: timestamp("seeded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.taskId, t.kind] })],
);

/** One result per scorer and trace. No trace content: numbers and a verdict only. */
export const traceScores = pgTable(
  "trace_scores",
  {
    scorerId: uuid("scorer_id")
      .notNull()
      .references(() => traceScorers.id, { onDelete: "cascade" }),
    traceId: text("trace_id").notNull(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // 1 or 0 for a pass or a fail; 1 to 5 for a numeric judge.
    value: doublePrecision("value").notNull(),
    // Null for a numeric judge, which has no pass mark.
    passed: boolean("passed"),
    // The decision model's confidence; null for a check.
    confidence: doublePrecision("confidence"),
    // The trace's own start, the time axis of every chart.
    traceStartedAt: timestamp("trace_started_at", { withTimezone: true }).notNull(),
    scoredAt: timestamp("scored_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.scorerId, t.traceId] }),
    index("trace_scores_project_trace_idx").on(t.projectId, t.traceId),
    index("trace_scores_scorer_started_idx").on(t.scorerId, t.traceStartedAt),
    index("trace_scores_project_started_idx").on(t.projectId, t.traceStartedAt),
  ],
);

/** What judge scorers spent per project and UTC day, held reservations included. */
export const scorerJudgeSpend = pgTable(
  "scorer_judge_spend",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    usd: numeric("usd", { precision: 12, scale: 6, mode: "number" }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.day] })],
);

export type ScorerRow = typeof traceScorers.$inferSelect;
export type TraceScoreRow = typeof traceScores.$inferSelect;
