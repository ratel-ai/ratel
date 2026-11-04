import { type SQL, sql } from "drizzle-orm";
import type { JobKind } from "@/lib/jobs/runner";

/**
 * How the queue treats each job kind (RC-212): which tier it is claimed in,
 * and how long it is expected to run.
 *
 * Tiers, claimed lowest first (fairness across projects still applies within
 * a tier, see claimNextQueuedJob):
 * - 0, someone is waiting on the page: a simulation, a What-if step, an eval
 *   set refresh, a fix draft;
 * - 1, fresh data: the chain that turns new runs into readings (turns,
 *   signals, task names and scores, intents, the graph fold) and a match
 *   quality run, which a person can also start by hand;
 * - 2, sweeps that can wait: tool reading, drafted tools, query categories.
 * Imports have their own lane in the worker and are not ranked here.
 */
export const JOB_TIER: Record<JobKind, 0 | 1 | 2> = {
  simulate_fix_eval: 0,
  simulate_task_eval: 0,
  what_if_step: 0,
  refresh_task_eval_set: 0,
  draft_fix: 0,
  build_trace_turns: 1,
  compute_trace_signals: 1,
  label_workflows: 1,
  score_tasks: 1,
  assign_topics: 1,
  cluster_intents: 1,
  fold_intent_graph: 1,
  match_quality_run: 1,
  run_import: 1,
  explore_tool_usage: 2,
  craft_tools: 2,
  categorize_queries: 2,
};

/**
 * Expected run time per kind. Past it the runner logs `job_over_budget`
 * (alerted on in Datadog), so a kind that grows slower is seen before it
 * starves the queue. Soft on purpose: a handler cannot be stopped midway
 * without losing its writes, so the hard limits stay the pool's statement
 * timeout (lib/db/pool.ts) and the reaper, which re-queues a job whose
 * worker died (STALE_JOB_MS).
 */
export const JOB_BUDGET_MS: Record<JobKind, number> = {
  build_trace_turns: 60_000,
  compute_trace_signals: 6 * 60_000,
  label_workflows: 3 * 60_000,
  score_tasks: 2 * 60_000,
  assign_topics: 5 * 60_000,
  cluster_intents: 3 * 60_000,
  fold_intent_graph: 2 * 60_000,
  match_quality_run: 8 * 60_000,
  run_import: 30 * 60_000,
  explore_tool_usage: 3 * 60_000,
  craft_tools: 3 * 60_000,
  categorize_queries: 3 * 60_000,
  simulate_fix_eval: 5 * 60_000,
  simulate_task_eval: 5 * 60_000,
  what_if_step: 3 * 60_000,
  refresh_task_eval_set: 2 * 60_000,
  draft_fix: 2 * 60_000,
};

/** A kind's tier; an unknown kind (a newer deploy's) waits with the sweeps. */
export function jobTier(kind: string): 0 | 1 | 2 {
  return (JOB_TIER as Record<string, 0 | 1 | 2>)[kind] ?? 2;
}

export function jobBudgetMs(kind: string): number {
  return (JOB_BUDGET_MS as Record<string, number>)[kind] ?? 5 * 60_000;
}

/** The tier as a SQL expression over a jobs row's `kind`, for the claim's order. */
export function jobTierSql(kindColumn: SQL): SQL {
  const tiers = Object.entries(JOB_TIER).filter(([, tier]) => tier !== 2);
  return sql`(case ${kindColumn} ${sql.join(
    tiers.map(([kind, tier]) => sql`when ${kind} then ${sql.raw(String(tier))}`),
    sql` `,
  )} else 2 end)`;
}
