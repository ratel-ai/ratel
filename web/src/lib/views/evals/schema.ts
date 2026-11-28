import { sql } from "drizzle-orm";
import {
  boolean,
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
import type { CaseContent, CaseScorer, EarlierTurn } from "./domain/case";
import type { FrozenCase, TrialToolCall } from "./domain/experiment";
import type { ScorerResult, ScorerSnapshot } from "./domain/score";

/** The tables of evals. */

/** A case: its name and its labels. What it checks is in its versions. */
export const evalCases = pgTable(
  "eval_cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Plain text. A label for a task or an intent refers to no row.
    labels: text("labels").array().notNull().default(sql`'{}'::text[]`),
    // The identity provider's user id.
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("eval_cases_project_created_idx").on(t.projectId, t.createdAt)],
);

/** A version of a case. Only a draft changes: an approved version is frozen. */
export const evalCaseVersions = pgTable(
  "eval_case_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => evalCases.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    // "draft" | "approved"
    state: text("state").notNull().default("draft"),
    // In an object: a driver parses the text of a jsonb string one more time.
    input: jsonb("input").$type<{ value: unknown }>().notNull(),
    earlierTurns: jsonb("earlier_turns").$type<EarlierTurn[]>().notNull(),
    toolFixtures: jsonb("tool_fixtures").$type<CaseContent["toolFixtures"]>().notNull(),
    expectedOutput: text("expected_output"),
    scorers: jsonb("scorers").$type<CaseScorer[]>().notNull(),
    // No foreign key: a pruned turn must not change a version.
    sourceTurnId: uuid("source_turn_id"),
    // The recorded answer of that turn, for the editor. No scorer reads it.
    sourceOutput: text("source_output"),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("eval_case_versions_case_number_idx").on(t.caseId, t.number),
    uniqueIndex("eval_case_versions_one_draft_idx").on(t.caseId).where(sql`${t.state} = 'draft'`),
  ],
);

/** What the judge that Ratel pays spent, for each organization and UTC day, with what is held. */
export const evalJudgeSpend = pgTable(
  "eval_judge_spend",
  {
    organizationId: uuid("organization_id").notNull(),
    day: date("day").notNull(),
    usd: doublePrecision("usd").notNull(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.day] })],
);

/** One eval run. No route changes it. Only its state and its end change after the start. */
export const evalExperiments = pgTable(
  "eval_experiments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id").notNull(),
    // No foreign key: the record stays what it was.
    sandboxVersionId: uuid("sandbox_version_id").notNull(),
    sandboxName: text("sandbox_name").notNull(),
    gitCommit: text("git_commit").notNull(),
    gitDirty: boolean("git_dirty").notNull(),
    params: jsonb("params").$type<Record<string, unknown>>().notNull(),
    trialsPerCase: integer("trials_per_case").notNull(),
    caseVersions: jsonb("case_versions").$type<FrozenCase[]>().notNull(),
    scorerSnapshots: jsonb("scorer_snapshots").$type<Record<string, ScorerSnapshot[]>>().notNull(),
    // A person's identity provider id, or `key:<id>`.
    startedBy: text("started_by").notNull(),
    // "running" | "completed"
    state: text("state").notNull().default("running"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("eval_experiments_project_created_idx").on(t.projectId, t.createdAt),
    index("eval_experiments_running_idx").on(t.createdAt).where(sql`${t.state} = 'running'`),
  ],
);

/** One run of one case version. It never changes after it is `done`. */
export const evalTrials = pgTable(
  "eval_trials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    experimentId: uuid("experiment_id")
      .notNull()
      .references(() => evalExperiments.id, { onDelete: "cascade" }),
    caseVersionId: uuid("case_version_id").notNull(),
    position: integer("position").notNull(),
    index: integer("index").notNull(),
    // "pending" | "starting" | "running" | "scoring" | "done"
    state: text("state").notNull().default("pending"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    // "pass" | "fail" | "invalid"
    result: text("result"),
    reason: text("reason"),
    output: jsonb("output").$type<{ value: unknown }>(),
    toolCalls: jsonb("tool_calls").$type<TrialToolCall[]>().notNull().default([]),
    scorers: jsonb("scorers").$type<ScorerResult[]>().notNull().default([]),
    costUsd: doublePrecision("cost_usd"),
    durationMs: doublePrecision("duration_ms"),
    traceId: text("trace_id"),
    sandboxRunId: uuid("sandbox_run_id"),
  },
  (t) => [
    uniqueIndex("eval_trials_experiment_position_idx").on(t.experimentId, t.position),
    index("eval_trials_open_idx").on(t.experimentId).where(sql`${t.state} <> 'done'`),
  ],
);

/** The pinned baseline of a project. A person pins and unpins it, in the console or with a key. No job writes here. */
export const evalBaselines = pgTable("eval_baselines", {
  projectId: uuid("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  experimentId: uuid("experiment_id")
    .notNull()
    .references(() => evalExperiments.id, { onDelete: "cascade" }),
  // A person's identity provider id, or `key:<id>`.
  pinnedBy: text("pinned_by").notNull(),
  pinnedAt: timestamp("pinned_at", { withTimezone: true }).notNull(),
});
