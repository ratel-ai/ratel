import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { projects } from "@/lib/platform/projects/schema";
import { evalRuns, evals } from "@/lib/views/evals/schema";

/**
 * User-written scorers (RC-612, switch `FF_EVALS`). Owned fragment of the upstream schema
 * (ADR-0030): `scorers`, `eval_scorer_overrides` and `run_scores`, the scorers partition of the
 * upstream schema hub, column for column, because production already has these tables
 * (ratel-cloud 0100, 0101). A task scorer names its task; a suite scorer applies to every eval in
 * the project. The config's shape depends on the kind; `lib/views/scorers/domain/config.ts`
 * validates it.
 */
export const scorers = pgTable(
  "scorers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    taskId: text("task_id"),
    scope: text("scope").$type<"task" | "suite">().notNull(),
    name: text("name").notNull(),
    kind: text("kind").$type<"check" | "expression" | "judge" | "decision">().notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    enabled: boolean("enabled").notNull().default(true),
    goodThreshold: doublePrecision("good_threshold").notNull().default(0.5),
    version: integer("version").notNull().default(1),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("scorers_project_task_idx").on(t.projectId, t.taskId),
    check("scorers_scope_check", sql`${t.scope} in ('task', 'suite')`),
    check("scorers_scope_task_check", sql`(${t.scope} = 'task') = (${t.taskId} is not null)`),
    check("scorers_kind_check", sql`${t.kind} in ('check', 'expression', 'judge', 'decision')`),
    check("scorers_threshold_check", sql`${t.goodThreshold} >= 0 and ${t.goodThreshold} <= 1`),
    check("scorers_version_check", sql`${t.version} > 0`),
  ],
);

/** One eval's own switch for one scorer. No row means the scorer's own switch applies. */
export const evalScorerOverrides = pgTable(
  "eval_scorer_overrides",
  {
    evalId: uuid("eval_id")
      .notNull()
      .references(() => evals.id, { onDelete: "cascade" }),
    scorerId: uuid("scorer_id")
      .notNull()
      .references(() => scorers.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.evalId, t.scorerId] }),
    index("eval_scorer_overrides_scorer_idx").on(t.scorerId),
  ],
);

/** RC-613: one user scorer's reading of one live task run (`turnId`) or of one eval in an eval run. */
export const runScores = pgTable(
  "run_scores",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    scorerId: uuid("scorer_id")
      .notNull()
      .references(() => scorers.id, { onDelete: "cascade" }),
    scorerVersion: integer("scorer_version").notNull(),
    turnId: uuid("turn_id"),
    evalRunId: uuid("eval_run_id").references(() => evalRuns.id, { onDelete: "cascade" }),
    evalId: uuid("eval_id").references(() => evals.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    status: text("status").$type<"pass" | "fail" | "skip">().notNull(),
    value: doublePrecision("value"),
    passed: boolean("passed"),
    detail: text("detail").notNull().default(""),
    scoredAt: timestamp("scored_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("run_scores_scorer_turn_idx")
      .on(t.scorerId, t.turnId)
      .where(sql`${t.turnId} IS NOT NULL`),
    uniqueIndex("run_scores_scorer_eval_idx")
      .on(t.scorerId, t.evalRunId, t.evalId)
      .where(sql`${t.evalRunId} IS NOT NULL`),
    index("run_scores_scorer_day_idx").on(t.scorerId, t.day),
    check("run_scores_status_check", sql`${t.status} in ('pass', 'fail', 'skip')`),
    check(
      "run_scores_subject_check",
      sql`(${t.turnId} is not null) <> (${t.evalRunId} is not null and ${t.evalId} is not null)`,
    ),
  ],
);

export type RunScoreRow = typeof runScores.$inferSelect;
export type ScorerRow = typeof scorers.$inferSelect;
export type EvalScorerOverrideRow = typeof evalScorerOverrides.$inferSelect;
