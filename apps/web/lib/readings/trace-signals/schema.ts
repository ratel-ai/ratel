import { sql } from "drizzle-orm";
import {
  boolean,
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
import { traceTurns } from "@/lib/ledger/schema";
import { projects } from "@/lib/platform/projects/schema";

/**
 * The Agent health reading's tables: signal runs and the signals they open, the workflow
 * names and decisions, and the self-corrections read from each window. Owned fragment of
 * the upstream schema (ADR-0030). Everything here is derived from the turn ledger and is
 * rewritten by the next run; nothing stores query text, error text or an end-user id.
 */

/**
 * One signal run over a project's closed turns. At most one live (`queued` or `running`)
 * run per project, enforced by the partial unique index.
 */
export const traceSignalRuns = pgTable(
  "trace_signal_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // "scheduled" | "manual" | "first_build" | "data_fixed".
    trigger: text("trigger").notNull(),
    // "queued" | "running" | "completed" | "failed".
    status: text("status").notNull().default("queued"),
    windowDays: integer("window_days").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    // The project's turn-ledger cursor when the run started.
    ledgerThrough: timestamp("ledger_through", { withTimezone: true }),
    // Closed turns the detectors read (inside the window).
    turnsScanned: integer("turns_scanned").notNull().default(0),
    // Signals open (or acknowledged) after the run, newly opened by it, and
    // resolved by it (two consecutive misses).
    signalsOpen: integer("signals_open").notNull().default(0),
    signalsNew: integer("signals_new").notNull().default(0),
    signalsResolved: integer("signals_resolved").notNull().default(0),
    // { declared, inferred, otlp } turn counts inside the window.
    turnSourceMix: jsonb("turn_source_mix").$type<Record<string, number>>().notNull().default({}),
    // The catalog the run read (`ingest/runtime-catalog/inventory.ts`).
    corpusFingerprint: text("corpus_fingerprint"),
    // Daily buckets, flow map and capture facts (signals/project-metrics.ts).
    summary: jsonb("summary").$type<Record<string, unknown>>(),
    // Machine reason on failure: "time_budget", "stale", or the thrown message.
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("trace_signal_runs_project_created_idx").on(t.projectId, t.createdAt),
    uniqueIndex("trace_signal_runs_project_live_idx")
      .on(t.projectId)
      .where(sql`${t.status} in ('queued', 'running')`),
  ],
);

/**
 * One diagnostic finding about a project's agent, e.g. "create_task rides into 41% of
 * lists and is picked in 1%". Keyed by `(project, kind, subject_key)` so each run upserts
 * the same row: a signal keeps its `first_seen_at` across runs, two consecutive runs that
 * measure its kind and do not detect it resolve it, and a later detection reopens it. Runs
 * never touch `fixed` or `muted` rows' status, and never turn `acknowledged` back into
 * `open`.
 *
 * `subject_key` is a tool id, `skill:<id>`, `a>b` for an ordered chain, `a|b` for a
 * sibling pair, a query hash, `project`, or a mined workflow's stable id. `subject`
 * carries the catalog ids the claim names (display names are read from the catalog at
 * render time, never stored); a workflow's also carries its `coreTools` and
 * `typicalOrder`. `severity` is the Wilson bound the detector fired on and `impact` its
 * waste count; `metrics` holds the numbers the claim is built from, `evidence` up to 20
 * sampled turn ids with their offending `trace_events` ids. `classifier` is reserved for
 * a classifier tier and is never merged into `metrics`. `proposal_kind`/`proposal_id` are
 * plain text so a later proposal table needs no foreign key.
 *
 * PRIVACY: no query text, error text or end-user id is ever stored here.
 */
export const traceSignals = pgTable(
  "trace_signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // One of SIGNAL_KINDS in readings/trace-signals/view.ts.
    kind: text("kind").notNull(),
    // "tool" | "skill" | "tool_pair" | "query_cluster" | "project" | "source" | "workflow".
    subjectKind: text("subject_kind").notNull(),
    subjectKey: text("subject_key").notNull(),
    subject: jsonb("subject").$type<Record<string, unknown>>().notNull().default({}),
    // "runtime" | "otlp" | "mixed": which ingest lanes the evidence came from.
    lane: text("lane"),
    // "deterministic" | "classifier" | "judge".
    tier: text("tier").notNull().default("deterministic"),
    // "open" | "acknowledged" | "resolved" | "fixed" | "muted".
    status: text("status").notNull().default("open"),
    severity: doublePrecision("severity").notNull(),
    impact: doublePrecision("impact").notNull(),
    n: integer("n").notNull(),
    metrics: jsonb("metrics").$type<Record<string, unknown>>().notNull().default({}),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull().default({}),
    classifier: jsonb("classifier").$type<Record<string, unknown>>(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    lastRunId: uuid("last_run_id").references(() => traceSignalRuns.id, {
      onDelete: "set null",
    }),
    // Consecutive runs that measured this kind without detecting the signal.
    missedRuns: integer("missed_runs").notNull().default(0),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    // The user id (as the session port reports it) of whoever acknowledged it.
    acknowledgedBy: text("acknowledged_by"),
    mutedUntil: timestamp("muted_until", { withTimezone: true }),
    proposalKind: text("proposal_kind"),
    proposalId: text("proposal_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("trace_signals_project_kind_subject_idx").on(t.projectId, t.kind, t.subjectKey),
    index("trace_signals_project_status_idx").on(t.projectId, t.status),
  ],
);

/**
 * Workflow names: one row per (project, workflow id), written by the `label_workflows`
 * job. `input_hash` covers what the name was written from (core tools, order, tool
 * descriptions, sample asks), so a row is rewritten only when that input changes. Names
 * and one-line descriptions only.
 */
export const traceWorkflowLabels = pgTable(
  "trace_workflow_labels",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    workflowId: text("workflow_id").notNull(),
    inputHash: text("input_hash").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    // "llm" today; room for a user-written override later.
    labelSource: text("label_source").notNull().default("llm"),
    // A key from WORKFLOW_ICONS (workflows/icons.ts); null shows the default.
    icon: text("icon"),
    model: text("model"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.workflowId] })],
);

/**
 * Workflow decisions: which workflow a captured ask belongs to, as decided by the choice
 * model, cached per (project, ask, option set) so a verdict is paid for once.
 * `workflow_id` is null for "none of these". Hashes only: the ask text itself is never
 * stored here.
 */
export const traceWorkflowVerdicts = pgTable(
  "trace_workflow_verdicts",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    promptHash: text("prompt_hash").notNull(),
    optionsHash: text("options_hash").notNull(),
    // "workflow" | "none" | "unclear".
    verdict: text("verdict").notNull(),
    workflowId: text("workflow_id"),
    confidence: doublePrecision("confidence"),
    model: text("model"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.promptHash, t.optionsHash] })],
);

/**
 * Workflow insights: the latest read of which captured asks the choice model placed in
 * which workflow, and the asks no workflow serves, grouped. One row per project, replaced
 * by each `label_workflows` job. Holds at most a few short sample asks per group, already
 * captured content.
 */
export const traceWorkflowInsights = pgTable("trace_workflow_insights", {
  projectId: uuid("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  data: jsonb("data").$type<Record<string, unknown>>().notNull(),
  model: text("model"),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Self-corrections: one row per moment the agent backtracked in a closed turn: a retry,
 * a switch or a give-up after a failed call, a search or an ask repeated, or a reply
 * phrase ("I'm sorry", "Let me try again"). Kinds and the one definition live in
 * `self-corrections/`. Each signal run rewrites the rows of the turns in its window.
 *
 * PRIVACY: a phrase row keeps the category and the canonical phrase, never the reply;
 * `source_event_id` and the match range point into the captured event (content capture),
 * which is read only when an example is shown.
 */
export const traceSelfCorrections = pgTable(
  "trace_self_corrections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    turnId: uuid("turn_id")
      .notNull()
      .references(() => traceTurns.id, { onDelete: "cascade" }),
    // One of SELF_CORRECTION_KINDS, or "phrase".
    kind: text("kind").notNull(),
    stepOrdinal: integer("step_ordinal"),
    // The call before it (a skill as skill:<id>) and that call's outcome.
    toolId: text("tool_id"),
    toolOutcome: text("tool_outcome"),
    // A later call in the same turn succeeded.
    recovered: boolean("recovered"),
    workflowId: text("workflow_id"),
    // Phrase rows only: "apology" | "concession" | "retry" | "admission" | "backtrack", and the canonical phrase.
    phraseCategory: text("phrase_category"),
    phrase: text("phrase"),
    // Where the phrase sits in the captured reply, for highlighting. No foreign
    // key: captured events are pruned after 30 days and the row outlives them.
    sourceEventId: uuid("source_event_id"),
    matchStart: integer("match_start"),
    matchEnd: integer("match_end"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("trace_self_corrections_project_time_idx").on(t.projectId, t.occurredAt),
    index("trace_self_corrections_turn_idx").on(t.turnId),
  ],
);

export type TraceSignalRunRow = typeof traceSignalRuns.$inferSelect;
export type NewTraceSignalRunRow = typeof traceSignalRuns.$inferInsert;
export type TraceSignalRow = typeof traceSignals.$inferSelect;
export type NewTraceSignalRow = typeof traceSignals.$inferInsert;
