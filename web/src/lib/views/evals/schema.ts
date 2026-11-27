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
import type { CaseContent, EarlierTurn } from "./domain/case";
import type { DatasetKind, DatasetSettings, FrozenDataset } from "./domain/dataset";
import type { EvalScorerRef, FrozenEval } from "./domain/eval";
import type { FrozenCase, RunChanges, TrialToolCall, Variant } from "./domain/experiment";
import type { Matrix } from "./domain/matrix";
import type { ScorerResult, ScorerSnapshot } from "./domain/score";

/** The tables of evals (the `evals` flag). */

/**
 * A dataset: a named set of rows that many evals can use (decision `datasets-first-class`). A
 * `fixed` dataset has its rows (`eval_cases`). A query kind has only its settings: a run resolves
 * them and keeps the rows that it got (`eval_run_rows`).
 */
export const evalDatasets = pgTable(
  "eval_datasets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // "fixed" | "last_traces" | "task_traces" | "rql" | "choose"
    kind: text("kind").$type<DatasetKind>().notNull(),
    settings: jsonb("settings").$type<DatasetSettings>().notNull().default({}),
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
    // No foreign key in the schema of a version: a version never changes. Migration 0068 fills it.
    datasetId: uuid("dataset_id"),
    sandboxName: text("sandbox_name"),
    // Null: the newest ready version of the sandbox when a run starts. Else a pinned version.
    sandboxVersionId: uuid("sandbox_version_id"),
    params: jsonb("params").$type<Record<string, unknown>>().notNull(),
    // For some params, a list of values. A run has one variant for each combination.
    matrix: jsonb("matrix").$type<Matrix>().notNull().default({}),
    trials: integer("trials").notNull(),
    // References to the scorer library, or the eval's own scorers (from before the library).
    scorers: jsonb("scorers").$type<EvalScorerRef[]>().notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("eval_definition_versions_eval_number_idx").on(t.evalId, t.number)],
);

/**
 * A case: a row of a fixed dataset, its name and its labels. What it holds is in its versions. A row
 * is a copy of a trace turn (`source_turn_id`), or values that a person typed.
 */
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
    // The eval that the row was added through. Null: added to the dataset itself.
    evalId: uuid("eval_id").references(() => evalDefinitions.id, { onDelete: "set null" }),
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
    // The eval of the run (decision `runs-per-eval`). Null for a suite run from before. No foreign
    // key: the record stays what it was.
    evalId: uuid("eval_id"),
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
    // The dataset that the run used, as it was. Null for a run from before datasets.
    dataset: jsonb("dataset").$type<FrozenDataset>(),
    // One for each combination of the matrix. Empty for a run from before: one variant, `params`.
    variants: jsonb("variants").$type<Variant[]>().notNull().default([]),
    // What the run changed for itself only.
    changes: jsonb("changes").$type<RunChanges>().notNull().default({}),
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
    index("eval_experiments_eval_created_idx").on(t.projectId, t.evalId, t.createdAt),
  ],
);

/**
 * The rows that a run resolved from a query dataset, and the rows that it added for itself. They
 * never change. A trial reads them as it reads a case version.
 */
export const evalRunRows = pgTable(
  "eval_run_rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    experimentId: uuid("experiment_id")
      .notNull()
      .references(() => evalExperiments.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    name: text("name").notNull(),
    input: jsonb("input").$type<{ value: unknown }>().notNull(),
    earlierTurns: jsonb("earlier_turns").$type<EarlierTurn[]>().notNull(),
    toolFixtures: jsonb("tool_fixtures").$type<CaseContent["toolFixtures"]>().notNull(),
    expectedOutput: text("expected_output"),
    // No foreign key: a pruned turn must not change a run.
    sourceTurnId: uuid("source_turn_id"),
    sourceOutput: text("source_output"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("eval_run_rows_experiment_position_idx").on(t.experimentId, t.position)],
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
    // The variant of the run (a combination of the matrix). 0 for a run with no matrix.
    variant: integer("variant").notNull().default(0),
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

/** The pinned baseline of a project, for the suite runs from before runs had one eval. No job writes here. */
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

/** The pinned baseline run of one eval (decision `runs-per-eval`). No job writes here. */
export const evalPinnedBaselines = pgTable(
  "eval_pinned_baselines",
  {
    evalId: uuid("eval_id")
      .primaryKey()
      .references(() => evalDefinitions.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    experimentId: uuid("experiment_id")
      .notNull()
      .references(() => evalExperiments.id, { onDelete: "cascade" }),
    // A person's identity provider id, or `key:<id>`.
    pinnedBy: text("pinned_by").notNull(),
    pinnedAt: timestamp("pinned_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("eval_pinned_baselines_project_idx").on(t.projectId)],
);
