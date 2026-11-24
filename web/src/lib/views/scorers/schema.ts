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
import type { TraceFilter } from "@/lib/synthesis/traces/trace-filters";
import type { CheckConfig, JudgeConfig, ScorerKind } from "./types";

/** A project's scorers. Each row carries its own sweep cursor, so a new scorer starts at "now". */
export const scorers = pgTable(
  "scorers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").$type<ScorerKind>().notNull(),
    config: jsonb("config").$type<CheckConfig | JudgeConfig>().notNull(),
    filter: jsonb("filter").$type<TraceFilter>().notNull().default({}),
    sampleRate: integer("sample_rate").notNull().default(100),
    enabled: boolean("enabled").notNull().default(true),
    // The last `(updated_at, trace_id)` of `otel_trace_summaries` the sweep read for this scorer.
    // A string, not a Date: a Date keeps milliseconds and `updated_at` has microseconds.
    cursorAt: timestamp("cursor_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    cursorTraceId: text("cursor_trace_id").notNull().default(""),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("scorers_project_idx").on(t.projectId, t.createdAt),
    index("scorers_enabled_idx").on(t.cursorAt).where(sql`${t.enabled}`),
    check("scorers_kind_check", sql`${t.kind} in ('check', 'judge')`),
    check("scorers_sample_rate_check", sql`${t.sampleRate} between 1 and 100`),
  ],
);

/** One result per scorer and trace. No trace content: numbers and a verdict only. */
export const traceScores = pgTable(
  "trace_scores",
  {
    scorerId: uuid("scorer_id")
      .notNull()
      .references(() => scorers.id, { onDelete: "cascade" }),
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

export type ScorerRow = typeof scorers.$inferSelect;
export type TraceScoreRow = typeof traceScores.$inferSelect;
