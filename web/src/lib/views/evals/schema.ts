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
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { projects } from "@/lib/platform/projects/schema";
import type { CaseContent, EarlierTurn } from "./domain/case";
import type { DatasetKind } from "./domain/dataset";
import type { EvalScorer, FrozenEval, ParamMatrix } from "./domain/eval";
import type { FrozenCase, RunChanges, TrialToolCall, Variant } from "./domain/experiment";
import type { ScorerResult, ScorerSnapshot } from "./domain/score";

/** The tables of evals (the `evals` flag). */

/**
 * A dataset: named rows that many evals can use (decision `datasets-first-class`). A `fixed` one
 * holds its rows. A query kind holds its settings, and a run resolves and freezes its rows.
 */
export const evalDatasets = pgTable(
  "eval_datasets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    kind: text("kind").$type<DatasetKind>().notNull(),
    // The settings of a query kind (N, task id, RQL text or the choose rule), without the kind.
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    // The identity provider's user id, or `key:<id>`.
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("eval_datasets_project_name_idx").on(t.projectId, t.name)],
);

/** An eval: its name and its task. What it runs and how it scores is in its versions. */
export const evalDefinitions = pgTable(
  "eval_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // No foreign key: a task is a reading of the traces, not a row of this module.
    taskId: text("task_id"),
    // The identity provider's user id, or `key:<id>`.
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("eval_definitions_project_name_idx").on(t.projectId, t.name)],
);

/** A version of an eval. It never changes: an edit adds a version, and a run freezes one. */
export const evalDefinitionVersions = pgTable(
  "eval_definition_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    evalId: uuid("eval_id")
      .notNull()
      .references(() => evalDefinitions.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    // The dataset of the version. Migration 0068 gave each version the dataset of its eval.
    datasetId: uuid("dataset_id")
      .notNull()
      .references(() => evalDatasets.id, { onDelete: "no action" }),
    sandboxName: text("sandbox_name"),
    // A pinned version of the sandbox. Null: its newest ready version. No foreign key: a record.
    sandboxVersionId: uuid("sandbox_version_id"),
    params: jsonb("params").$type<Record<string, unknown>>().notNull(),
    matrix: jsonb("matrix").$type<ParamMatrix>().notNull().default({}),
    trials: integer("trials").notNull(),
    scorers: jsonb("scorers").$type<EvalScorer[]>().notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("eval_definition_versions_eval_number_idx").on(t.evalId, t.number),
    index("eval_definition_versions_dataset_idx").on(t.datasetId),
  ],
);

/** A case: a row of a dataset, its name and its labels. What it holds is in its versions. */
export const evalCases = pgTable(
  "eval_cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    datasetId: uuid("dataset_id")
      .notNull()
      .references(() => evalDatasets.id, { onDelete: "cascade" }),
    // The eval that the row was saved to. Null for a row added to a dataset, or resolved by a query.
    evalId: uuid("eval_id").references(() => evalDefinitions.id, { onDelete: "cascade" }),
    // The turn of a row that a query resolved. One row for each turn: a run adds a version when the
    // turn's content changed. Null for a row of a fixed dataset.
    resolvedTurnId: uuid("resolved_turn_id"),
    // A row that one run added for itself: it is not a row of the dataset.
    runOnly: boolean("run_only").notNull().default(false),
    // A row that a person removed from its fixed dataset. It stays for the runs that froze it.
    removedAt: timestamp("removed_at", { withTimezone: true }),
    name: text("name").notNull(),
    // Plain text. A label for a task or an intent refers to no row.
    labels: text("labels").array().notNull().default(sql`'{}'::text[]`),
    // The identity provider's user id.
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("eval_cases_project_created_idx").on(t.projectId, t.createdAt),
    index("eval_cases_eval_idx").on(t.evalId),
    index("eval_cases_dataset_idx").on(t.datasetId),
    uniqueIndex("eval_cases_dataset_turn_idx")
      .on(t.datasetId, t.resolvedTurnId)
      .where(sql`${t.resolvedTurnId} is not null`),
  ],
);

/** A version of a case (a row of a dataset). It never changes: an edit adds a version, and the newest counts. */
export const evalCaseVersions = pgTable(
  "eval_case_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => evalCases.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    // In an object: a driver parses the text of a jsonb string one more time.
    input: jsonb("input").$type<{ value: unknown }>().notNull(),
    earlierTurns: jsonb("earlier_turns").$type<EarlierTurn[]>().notNull(),
    toolFixtures: jsonb("tool_fixtures").$type<CaseContent["toolFixtures"]>().notNull(),
    expectedOutput: text("expected_output"),
    // No foreign key: a pruned turn must not change a version.
    sourceTurnId: uuid("source_turn_id"),
    // The recorded answer of that turn, for the editor. No scorer reads it.
    sourceOutput: text("source_output"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("eval_case_versions_case_number_idx").on(t.caseId, t.number)],
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
    // The one eval of the run (decision `runs-per-eval`). Null for a suite run from before.
    // No foreign key, as the other ids of the record.
    evalId: uuid("eval_id"),
    // The dataset that the run read. Null for a suite run from before.
    datasetId: uuid("dataset_id"),
    // One for each combination of the matrix. Empty: one run with the params of the run.
    variants: jsonb("variants").$type<Variant[]>().notNull().default([]),
    // What the run changed for itself only, as it was asked.
    changes: jsonb("changes").$type<RunChanges>().notNull().default({}),
    // No foreign key: the record stays what it was.
    sandboxVersionId: uuid("sandbox_version_id").notNull(),
    sandboxName: text("sandbox_name").notNull(),
    name: text("name"),
    labelFilter: text("label_filter"),
    gitCommit: text("git_commit").notNull(),
    gitDirty: boolean("git_dirty").notNull(),
    params: jsonb("params").$type<Record<string, unknown>>().notNull(),
    trialsPerCase: integer("trials_per_case").notNull(),
    caseVersions: jsonb("case_versions").$type<FrozenCase[]>().notNull(),
    // Empty for a run that started before evals had definitions.
    evalVersions: jsonb("eval_versions").$type<FrozenEval[]>().notNull().default([]),
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
    // The index of the variant of the run. 0 for a run with no variant.
    variant: integer("variant").notNull().default(0),
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

/**
 * The pinned baseline of each eval of a project (decision `runs-per-eval`), and the one of the suite
 * runs from before (`eval_id` null). A person pins and unpins it, in the console or with a key. No
 * job writes here.
 */
export const evalBaselines = pgTable(
  "eval_baselines",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    evalId: uuid("eval_id").references(() => evalDefinitions.id, { onDelete: "cascade" }),
    experimentId: uuid("experiment_id")
      .notNull()
      .references(() => evalExperiments.id, { onDelete: "cascade" }),
    // A person's identity provider id, or `key:<id>`.
    pinnedBy: text("pinned_by").notNull(),
    pinnedAt: timestamp("pinned_at", { withTimezone: true }).notNull(),
  },
  (t) => [unique("eval_baselines_project_eval_key").on(t.projectId, t.evalId).nullsNotDistinct()],
);
