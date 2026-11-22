import { sql } from "drizzle-orm";
import {
  bigint,
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
import { traceSignalRuns } from "@/lib/readings/trace-signals/schema";

/**
 * The tool explorer's tables: one run per pass over a project's closed turns, and the
 * edges, co-used sets and intent-to-tool shares it stores. Owned fragment of the upstream
 * schema (ADR-0030). Everything here is derived from the turn ledger and replaced by the
 * next run; nothing stores query text or an end-user id. The `explore_tool_usage` queued-job
 * index lives with the `jobs` table (`lib/jobs/schema.ts`).
 */

/**
 * One pass of the tool explorer over a project's closed turns: the `explore_tool_usage`
 * job writes one row per run and the edge and set rows below with it. It reads the same
 * turn ledger as Agent health and runs after each of its signal runs (`signal_run_id`), or
 * on a manual recompute.
 *
 * `summary` holds what the page needs besides the rows: unit counts per scope (`turn` and
 * `session`), the nodes (tool ids with call and unit counts) and which caps the run hit.
 * Earlier completed runs of a project are deleted when a new one persists, so the fact
 * tables hold one run per project.
 *
 * PRIVACY: tool ids, intent ids and session ids only; no query text.
 */
export const toolExplorerRuns = pgTable(
  "tool_explorer_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // "chained" (after a signal run) | "manual".
    trigger: text("trigger").notNull(),
    // "queued" | "running" | "completed" | "failed".
    status: text("status").notNull().default("queued"),
    windowDays: integer("window_days").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    signalRunId: uuid("signal_run_id").references(() => traceSignalRuns.id, {
      onDelete: "set null",
    }),
    turnsScanned: integer("turns_scanned").notNull().default(0),
    sessionsScanned: integer("sessions_scanned").notNull().default(0),
    // Turns that carried at least one extracted intent (the intent join).
    turnsWithIntents: integer("turns_with_intents").notNull().default(0),
    summary: jsonb("summary").$type<Record<string, unknown>>(),
    // Machine reason on failure: "time_budget", "stale", or the thrown message.
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("tool_explorer_runs_project_created_idx").on(t.projectId, t.createdAt),
    uniqueIndex("tool_explorer_runs_project_live_idx")
      .on(t.projectId)
      .where(sql`${t.status} in ('queued', 'running')`),
  ],
);

/**
 * A directed edge between two tools (or two intents) in one tool explorer run. `scope` is
 * `turn` or `session`; `kind` is `next` (b was the call right after a, repeats of a
 * collapsed) or `before` (a's first call preceded b's first call, counted once per unit);
 * `subject` is `tool` or `intent`.
 *
 * `p = n / n_a` with its Wilson interval, and `lift = p / (units_b / units)`. `reverse_n`
 * is the count of the opposite edge so a reader can tell a one-way dependency from a pair
 * that runs either way around.
 */
export const toolExplorerEdges = pgTable(
  "tool_explorer_edges",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => toolExplorerRuns.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    kind: text("kind").notNull(),
    subject: text("subject").notNull(),
    a: text("a").notNull(),
    b: text("b").notNull(),
    n: integer("n").notNull(),
    nA: integer("n_a").notNull(),
    p: doublePrecision("p").notNull(),
    pLow: doublePrecision("p_low").notNull(),
    pHigh: doublePrecision("p_high").notNull(),
    lift: doublePrecision("lift").notNull(),
    reverseN: integer("reverse_n").notNull().default(0),
    // Up to a handful of session ids that show the edge, for drill-down.
    exampleSessions: text("example_sessions").array().notNull().default([]),
    // `next` edges: the hand-off between a's end and b's start over the pairs with both
    // timestamps, and the searches that sat in it. Null on `before` edges.
    timedPairs: integer("timed_pairs"),
    betweenMsTotal: bigint("between_ms_total", { mode: "number" }),
    betweenMsMedian: integer("between_ms_median"),
    searchesBetween: integer("searches_between"),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.scope, t.kind, t.subject, t.a, t.b] }),
    index("tool_explorer_edges_run_a_idx").on(t.runId, t.scope, t.kind, t.a, t.n),
  ],
);

/**
 * A set of tools (or intents) that run together in one unit, mined as a frequent itemset
 * in one tool explorer run. `key` is the sorted ids joined by `|`. `support` is the units
 * containing the set and `share` that over all units with at least one call. Pairs also
 * carry `jaccard` (support over the units holding either), its Wilson lower bound, and
 * each direction's conditional share, which is what tells "always together" from "often
 * together". `workflow_id` names the Agent health workflow with the same core tools, when
 * there is one.
 */
export const toolExplorerSets = pgTable(
  "tool_explorer_sets",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => toolExplorerRuns.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    subject: text("subject").notNull(),
    key: text("key").notNull(),
    items: text("items").array().notNull(),
    size: integer("size").notNull(),
    support: integer("support").notNull(),
    share: doublePrecision("share").notNull(),
    jaccard: doublePrecision("jaccard"),
    jaccardLow: doublePrecision("jaccard_low"),
    pAb: doublePrecision("p_ab"),
    pBa: doublePrecision("p_ba"),
    workflowId: text("workflow_id"),
    exampleSessions: text("example_sessions").array().notNull().default([]),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.scope, t.subject, t.key] }),
    index("tool_explorer_sets_run_support_idx").on(t.runId, t.scope, t.subject, t.size, t.support),
  ],
);

/**
 * Which tools serve an intent: for each (scope, intent) in a tool explorer run, the units
 * carrying the intent and, per tool, how many of those units called it. `intent_id` is a
 * `query_intents.id`, kept without a foreign key because intents can be rewritten between
 * runs.
 */
export const toolExplorerIntentTools = pgTable(
  "tool_explorer_intent_tools",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => toolExplorerRuns.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    intentId: uuid("intent_id").notNull(),
    intentUnits: integer("intent_units").notNull(),
    toolId: text("tool_id").notNull(),
    n: integer("n").notNull(),
    share: doublePrecision("share").notNull(),
    shareLow: doublePrecision("share_low").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.scope, t.intentId, t.toolId] }),
    index("tool_explorer_intent_tools_run_intent_idx").on(t.runId, t.scope, t.intentId, t.n),
  ],
);

export type ToolExplorerRunRow = typeof toolExplorerRuns.$inferSelect;
export type NewToolExplorerRunRow = typeof toolExplorerRuns.$inferInsert;
export type ToolExplorerEdgeRow = typeof toolExplorerEdges.$inferSelect;
export type NewToolExplorerEdgeRow = typeof toolExplorerEdges.$inferInsert;
export type ToolExplorerSetRow = typeof toolExplorerSets.$inferSelect;
export type NewToolExplorerSetRow = typeof toolExplorerSets.$inferInsert;
export type ToolExplorerIntentToolRow = typeof toolExplorerIntentTools.$inferSelect;
export type NewToolExplorerIntentToolRow = typeof toolExplorerIntentTools.$inferInsert;
