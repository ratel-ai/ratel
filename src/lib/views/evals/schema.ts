import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  index,
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
 * The agent-wide eval set (RC-287, switch `FF_EVALS`). Owned fragment of the upstream schema
 * (ADR-0030): `evals`, `eval_tasks`, `eval_runs`, `eval_results`, `eval_nightly_settings` and
 * `eval_suite_settings`, the evals partition of the upstream schema hub, column for column,
 * because production already has these tables (ratel-cloud 0088-0105). An eval is one recorded
 * ask; `eval_tasks` links it to tasks (workflow ids, many-to-many, like `fix_shipment_tasks`).
 * Domain types live in `lib/views/evals/domain/types.ts`; the JSON shapes here stay loose so the
 * schema does not import the feature.
 *
 * PRIVACY: `eval_results.transcript` and each message in `eval_results.turns` hold replay text.
 * They are written only when the project's content opt-in is on and are cleared after 30 days.
 */
export const evals = pgTable(
  "evals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    sourceTurnId: uuid("source_turn_id"),
    // The task eval case it was imported or suggested from, so an import runs once.
    sourceCaseId: uuid("source_case_id"),
    message: text("message").notNull(),
    earlierMessages: jsonb("earlier_messages")
      .$type<
        {
          role: "user" | "assistant" | "tool";
          text: string;
          tool?: string;
          args?: Record<string, unknown>;
        }[]
      >()
      .notNull()
      .default([]),
    // RC-296: a plain string (before RC-296) or { kind: "message", text } / { kind: "person", description }.
    turns: jsonb("turns")
      .$type<
        (string | { kind: "message"; text: string } | { kind: "person"; description: string })[]
      >()
      .notNull()
      .default([]),
    checks: jsonb("checks")
      .$type<Record<string, { on: boolean; max?: number }>>()
      .notNull()
      .default({}),
    expectedTool: text("expected_tool"),
    criteria: text("criteria").notNull().default(""),
    fixedAnswers: jsonb("fixed_answers")
      .$type<{ tool: string; result: unknown; when?: Record<string, unknown>; why?: string }[]>()
      .notNull()
      .default([]),
    // RC-608: the spec, from the recording when it has it, else written by a model at creation (`generated` names those fields).
    systemPrompt: text("system_prompt"),
    tools:
      jsonb("tools").$type<
        { name: string; description: string; parameters: Record<string, unknown> }[]
      >(),
    context: jsonb("context").$type<Record<string, string>>(),
    generated: jsonb("generated").$type<("systemPrompt" | "message" | "tools" | "context")[]>(),
    // RC-616: the low reading that made a score-based suggestion; null on every other eval.
    suggestionReason: jsonb("suggestion_reason").$type<{
      scorerId: string;
      scorerName: string;
      value: number;
      threshold: number;
    }>(),
    /** RC-642: the spec fields a person edited; they win over the recording. Null when no one edited one. */
    edited: jsonb("edited").$type<("systemPrompt" | "message" | "tools" | "context")[]>(),
    /** RC-653: the eval's own run settings (models and limits); null: the suite default, then today's. */
    runSettings: jsonb("run_settings").$type<Record<string, string | number>>(),
    /** RC-654: the steps a run starts with after the ask (an edited agent reply and the steps before it); null: none. */
    opening: jsonb("opening").$type<Record<string, unknown>[]>(),
    status: text("status")
      .$type<"suggested" | "approved" | "archived">()
      .notNull()
      .default("suggested"),
    origin: text("origin").$type<"auto" | "issue" | "user" | "fix" | "session">().notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("evals_project_status_idx").on(t.projectId, t.status),
    unique("evals_project_source_case_key").on(t.projectId, t.sourceCaseId),
    check("evals_status_check", sql`${t.status} in ('suggested', 'approved', 'archived')`),
    check("evals_origin_check", sql`${t.origin} in ('auto', 'issue', 'user', 'fix', 'session')`),
  ],
);

export const evalTasks = pgTable(
  "eval_tasks",
  {
    evalId: uuid("eval_id")
      .notNull()
      .references(() => evals.id, { onDelete: "cascade" }),
    workflowId: text("workflow_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.evalId, t.workflowId] }),
    index("eval_tasks_workflow_idx").on(t.workflowId),
  ],
);

/** One run of the eval set: by hand, nightly, or a fix simulation (then `fix_id` is set). */
export const evalRuns = pgTable(
  "eval_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"manual" | "nightly" | "simulation">().notNull(),
    fixId: text("fix_id"),
    suite: text("suite").notNull().default(""),
    status: text("status")
      .$type<"queued" | "running" | "completed" | "failed">()
      .notNull()
      .default("queued"),
    spend: jsonb("spend")
      .$type<{ usd: number; reservedUsd: number; reserved: boolean }>()
      .notNull()
      .default({ usd: 0, reservedUsd: 0, reserved: false }),
    evalCount: integer("eval_count").notNull().default(0),
    error: text("error"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("eval_runs_project_created_idx").on(t.projectId, t.createdAt),
    check("eval_runs_kind_check", sql`${t.kind} in ('manual', 'nightly', 'simulation')`),
    check(
      "eval_runs_status_check",
      sql`${t.status} in ('queued', 'running', 'completed', 'failed')`,
    ),
    check("eval_runs_fix_check", sql`(${t.kind} = 'simulation') = (${t.fixId} is not null)`),
    check("eval_runs_count_check", sql`${t.evalCount} >= 0`),
  ],
);

/** One eval's result in one run, per side (`before` = as recorded, `after` = with the fix). */
export const evalResults = pgTable(
  "eval_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => evalRuns.id, { onDelete: "cascade" }),
    evalId: uuid("eval_id")
      .notNull()
      .references(() => evals.id, { onDelete: "cascade" }),
    side: text("side").$type<"before" | "after">().notNull().default("before"),
    passed: boolean("passed"),
    verdicts: jsonb("verdicts").$type<Record<string, unknown>[]>().notNull().default([]),
    change: text("change").$type<"now_fails" | "fixed" | "same" | "new">(),
    durationMs: integer("duration_ms"),
    costUsd: doublePrecision("cost_usd"),
    toolCalls: integer("tool_calls"),
    // Per call: tool, source, reason code, ms. No args or results: those are text.
    toolAnswers: jsonb("tool_answers").$type<Record<string, unknown>[]>().notNull().default([]),
    transcript: jsonb("transcript").$type<Record<string, unknown>>(),
    // RC-296: per-turn verdicts of a multi-turn eval, and a simulated person's pass rate over its runs.
    turns: jsonb("turns").$type<Record<string, unknown>[]>(),
    attempts: jsonb("attempts").$type<{ passed: number; total: number }>(),
    // RC-609: the spec inputs a model wrote (RC-608) that this run used; null when it used none.
    generated: jsonb("generated").$type<("systemPrompt" | "message" | "tools" | "context")[]>(),
    // RC-653: the run settings this result ran with, and where each came from; null on results before RC-653.
    runSettings: jsonb("run_settings").$type<Record<string, unknown>>(),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("eval_results_run_eval_side_key").on(t.runId, t.evalId, t.side),
    index("eval_results_eval_created_idx").on(t.evalId, t.createdAt),
    index("eval_results_transcript_created_idx")
      .on(t.createdAt)
      .where(sql`${t.transcript} is not null`),
    check("eval_results_side_check", sql`${t.side} in ('before', 'after')`),
    check("eval_results_change_check", sql`${t.change} in ('now_fails', 'fixed', 'same', 'new')`),
  ],
);

/**
 * Nightly runs of the eval set (RC-299): one row per project that an admin changed. No row
 * means off. Paid plans only, checked on change and in the drain sweep.
 */
export const evalNightlySettings = pgTable("eval_nightly_settings", {
  projectId: uuid("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(false),
  setBy: text("set_by").notNull(),
  setAt: timestamp("set_at", { withTimezone: true }).notNull().defaultNow(),
});

/** RC-653: the suite default run settings of a project, under each eval's own. No row means today's defaults. */
export const evalSuiteSettings = pgTable("eval_suite_settings", {
  projectId: uuid("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  runSettings: jsonb("run_settings").$type<Record<string, string | number>>().notNull().default({}),
  setBy: text("set_by").notNull(),
  setAt: timestamp("set_at", { withTimezone: true }).notNull().defaultNow(),
});

export type EvalRow = typeof evals.$inferSelect;
export type EvalRunRow = typeof evalRuns.$inferSelect;
export type EvalResultRow = typeof evalResults.$inferSelect;
