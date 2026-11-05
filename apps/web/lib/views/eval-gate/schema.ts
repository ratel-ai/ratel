import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { projects } from "@/lib/platform/projects/schema";

/**
 * The eval gate's tables. Owned fragment of the upstream schema (ADR-0030): `fix_eval_sets`,
 * `fix_eval_cases` and `fix_eval_runs`, the eval-gate partition of the upstream schema hub,
 * column for column.
 */

/**
 * The eval gate (RC-46): each fix's editable eval set, its runs, and every
 * simulation of the fix over them. A fix is not a table (`lib/views/fixes`), so a
 * set is keyed by the fix's own id (`craft:<uuid>`, `rewrite:<uuid>`,
 * `issue:<uuid>`, `intent:<id>`), one per project and fix.
 *
 * `change` is the snapshot of what the simulation applies (`lib/views/eval-gate/
 * change.ts`), stored so a re-run replays the same change even after the fix's
 * source moved on. `source` is the insight the fix came from, as a LineageRef.
 *
 * PRIVACY: no query text, error text or end-user id is ever stored here.
 */
export const fixEvalSets = pgTable(
  "fix_eval_sets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    fixId: text("fix_id").notNull(),
    // The fix's kind (FixKind in lib/views/fixes/kinds.ts) when the set was made.
    fixKind: text("fix_kind").notNull(),
    title: text("title").notNull(),
    change: jsonb("change").$type<Record<string, unknown>>().notNull().default({}),
    source: jsonb("source").$type<Record<string, unknown>>(),
    // How many runs "Add runs from history" fills the set up to.
    targetRuns: integer("target_runs").notNull().default(20),
    // The identity provider's user id, `mcp`, or `system:eval-gate`.
    createdBy: text("created_by"),
    // RC-61: every run the fix's issues cite as evidence. Those runs are scored
    // apart and never decide the verdict (the holdout is the rest).
    evidenceTurnIds: text("evidence_turn_ids").array().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("fix_eval_sets_project_fix_idx").on(t.projectId, t.fixId)],
);

/**
 * One historical run in a fix's eval set, with what it should do once the fix
 * is made. `turn_id` points at `trace_turns` without a foreign key: the ledger
 * can be rebuilt, and a missing run reads as "run gone" rather than deleting
 * the person's edits. `origin` says how it got here: `issue` (the evidence of
 * the insight), `tool`, `task`, or `manual`.
 */
export const fixEvalCases = pgTable(
  "fix_eval_cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    setId: uuid("set_id")
      .notNull()
      .references(() => fixEvalSets.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    turnId: uuid("turn_id").notNull(),
    traceId: text("trace_id"),
    origin: text("origin").notNull(),
    originRef: text("origin_ref"),
    // { tool, maxToolCalls, maxSearches, maxFailedCalls, avoidTools } (lib/views/eval-gate/types.ts).
    expected: jsonb("expected").$type<Record<string, unknown>>().notNull().default({}),
    // The expected outcome and the criteria, in the person's own words.
    outcome: text("outcome").notNull().default(""),
    criteria: text("criteria").notNull().default(""),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("fix_eval_cases_set_turn_idx").on(t.setId, t.turnId),
    index("fix_eval_cases_set_position_idx").on(t.setId, t.position),
  ],
);

/**
 * One simulation of a fix over its eval set: queued by a person, MCP or the
 * job, run in-process (`simulate_fix_eval`). `before` and `after` are
 * `{ passed, total, passRate, score }`; `results` holds each run's ranks,
 * counts and checks, never its text. One live run per set.
 */
export const fixEvalRuns = pgTable(
  "fix_eval_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    setId: uuid("set_id")
      .notNull()
      .references(() => fixEvalSets.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // "queued" | "running" | "completed" | "failed".
    status: text("status").notNull().default("queued"),
    // "manual" | "mcp".
    trigger: text("trigger").notNull(),
    requestedBy: text("requested_by"),
    jobId: uuid("job_id"),
    nCases: integer("n_cases").notNull().default(0),
    nSimulated: integer("n_simulated").notNull().default(0),
    before: jsonb("before").$type<Record<string, unknown>>(),
    after: jsonb("after").$type<Record<string, unknown>>(),
    interval: jsonb("interval").$type<Record<string, unknown>>(),
    // "better" | "same" | "worse" | "too-few" | "unsupported".
    verdict: text("verdict"),
    results: jsonb("results").$type<Record<string, unknown>[]>(),
    change: jsonb("change").$type<Record<string, unknown>>(),
    error: text("error"),
    // RC-61: whether model replay was on when it was queued (the job reads it);
    // the evidence runs' tallies, apart; graded runs by check group and by
    // method; what the models cost; whether the criteria were judged.
    replay: boolean("replay").notNull().default(false),
    evidence: jsonb("evidence").$type<Record<string, unknown>>(),
    breakdown: jsonb("breakdown").$type<Record<string, unknown>>(),
    methods: jsonb("methods").$type<Record<string, unknown>>(),
    spend: jsonb("spend").$type<Record<string, unknown>>(),
    judge: jsonb("judge").$type<Record<string, unknown>>(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("fix_eval_runs_set_created_idx").on(t.setId, t.createdAt),
    index("fix_eval_runs_project_created_idx").on(t.projectId, t.createdAt),
    uniqueIndex("fix_eval_runs_set_live_idx")
      .on(t.setId)
      .where(sql`${t.status} in ('queued', 'running')`),
  ],
);

export type FixEvalSetRow = typeof fixEvalSets.$inferSelect;
export type NewFixEvalSetRow = typeof fixEvalSets.$inferInsert;
export type FixEvalCaseRow = typeof fixEvalCases.$inferSelect;
export type NewFixEvalCaseRow = typeof fixEvalCases.$inferInsert;
export type FixEvalRunRow = typeof fixEvalRuns.$inferSelect;
export type NewFixEvalRunRow = typeof fixEvalRuns.$inferInsert;
