import { and, asc, desc, eq, sql } from "drizzle-orm";
import { traceTurns } from "@/lib/ledger/schema";
import { getDb } from "@/lib/platform/db/client";
import { type EvalDb, loadRuns } from "@/lib/views/eval-gate/runs";
import { defaultScorers, type TaskStats } from "@/lib/views/task-scorers/defaults";
import { SCORER_VERSION } from "@/lib/views/task-scorers/engine";
import { selfCorrectionsOf } from "@/lib/views/task-scorers/outcome";
import {
  type TaskScoreDailyRow,
  type TaskScorerRow,
  taskScorers,
  taskScoresDaily,
} from "@/lib/views/task-scorers/schema";
import type { Scorer, ScorerKind } from "@/lib/views/task-scorers/types";

export type TaskScorer = Scorer & {
  enabled: boolean;
  source: "default" | "user";
  version: number;
};

export interface ScorerInput {
  projectId: string;
  taskId: string;
  scorer: Scorer;
  enabled?: boolean;
  source?: "default" | "user";
  updatedBy: string;
}

export interface DailyScore {
  scorerKind: ScorerKind | "overall";
  scorerVersion: number;
  n: number;
  passed: number;
}

const DEFAULT_RUN_LIMIT = 500;

/** Return task defaults with stored overrides, including disabled user scorers. */
export async function scorersFor(
  projectId: string,
  taskId: string,
  db: EvalDb = getDb(),
): Promise<TaskScorer[]> {
  const stats = await taskStatsFor(projectId, taskId, db);
  const scorers = new Map<ScorerKind, TaskScorer>(
    defaultScorers(stats).map((scorer) => [
      scorer.kind,
      {
        ...scorer,
        enabled: true,
        source: "default",
        version: SCORER_VERSION,
      },
    ]),
  );
  const rows = await db
    .select()
    .from(taskScorers)
    .where(and(eq(taskScorers.projectId, projectId), eq(taskScorers.taskId, taskId)))
    .orderBy(asc(taskScorers.kind));
  for (const row of rows) {
    scorers.set(row.kind, {
      ...scorerOf(row.kind, row.config),
      enabled: row.enabled,
      source: row.source,
      version: row.version,
    });
  }
  return [...scorers.values()];
}

/** Save one scorer. Default refreshes preserve user rows. Callers enforce the feature flag. */
export async function upsertScorer(
  input: ScorerInput,
  db: EvalDb = getDb(),
): Promise<TaskScorerRow> {
  const { kind, ...config } = input.scorer;
  scorerOf(kind, config);
  const source = input.source ?? "user";
  const [saved] = await db
    .insert(taskScorers)
    .values({
      projectId: input.projectId,
      taskId: input.taskId,
      kind,
      config,
      enabled: input.enabled ?? true,
      source,
      updatedBy: input.updatedBy,
    })
    .onConflictDoUpdate({
      target: [taskScorers.projectId, taskScorers.taskId, taskScorers.kind],
      set: {
        config,
        enabled: input.enabled ?? true,
        source,
        version: sql`${taskScorers.version} + 1`,
        updatedBy: input.updatedBy,
        updatedAt: new Date(),
      },
      setWhere: source === "default" ? eq(taskScorers.source, "default") : undefined,
    })
    .returning();
  if (saved) return saved;
  const [existing] = await db
    .select()
    .from(taskScorers)
    .where(
      and(
        eq(taskScorers.projectId, input.projectId),
        eq(taskScorers.taskId, input.taskId),
        eq(taskScorers.kind, kind),
      ),
    );
  if (!existing) throw new Error("task scorer disappeared after a conflicting insert");
  return existing;
}

/** Delete a user override so the task's measured default applies again. */
export async function resetScorer(
  projectId: string,
  taskId: string,
  kind: ScorerKind,
  db: EvalDb = getDb(),
): Promise<boolean> {
  const removed = await db
    .delete(taskScorers)
    .where(
      and(
        eq(taskScorers.projectId, projectId),
        eq(taskScorers.taskId, taskId),
        eq(taskScorers.kind, kind),
        eq(taskScorers.source, "user"),
      ),
    )
    .returning({ kind: taskScorers.kind });
  return removed.length > 0;
}

/** Write a day's counts atomically. Callers enforce the cloud-eval-gate flag. */
export async function upsertDailyScores(
  projectId: string,
  taskId: string,
  day: string,
  scores: readonly DailyScore[],
  db: EvalDb = getDb(),
): Promise<void> {
  if (scores.length === 0) return;
  await db
    .insert(taskScoresDaily)
    .values(scores.map((score) => ({ projectId, taskId, day, ...score })))
    .onConflictDoUpdate({
      target: [
        taskScoresDaily.projectId,
        taskScoresDaily.taskId,
        taskScoresDaily.day,
        taskScoresDaily.scorerKind,
      ],
      set: {
        scorerVersion: sql`excluded.scorer_version`,
        n: sql`excluded.n`,
        passed: sql`excluded.passed`,
      },
    });
}

export async function dailyScoresFor(
  projectId: string,
  taskId: string,
  db: EvalDb = getDb(),
): Promise<TaskScoreDailyRow[]> {
  return db
    .select()
    .from(taskScoresDaily)
    .where(and(eq(taskScoresDaily.projectId, projectId), eq(taskScoresDaily.taskId, taskId)))
    .orderBy(asc(taskScoresDaily.day), asc(taskScoresDaily.scorerKind));
}

async function taskStatsFor(projectId: string, taskId: string, db: EvalDb): Promise<TaskStats> {
  const turns = await db
    .select({ id: traceTurns.id })
    .from(traceTurns)
    .where(
      and(
        eq(traceTurns.projectId, projectId),
        eq(traceTurns.workflowId, taskId),
        eq(traceTurns.status, "closed"),
      ),
    )
    .orderBy(desc(traceTurns.endedAt), desc(traceTurns.id))
    .limit(DEFAULT_RUN_LIMIT);
  const runs = [
    ...(
      await loadRuns(
        projectId,
        turns.map((turn) => turn.id),
        db,
      )
    ).values(),
  ];
  return {
    selfCorrections: median(
      runs.map((run) => {
        const calls = run.steps.filter((step) => step.kind === "invoke");
        return selfCorrectionsOf({
          calls: calls.map((call) => call.targetId),
          outcomes: calls.map((call) => call.outcome),
        });
      }),
    ),
    costUsd: median(runs.map((run) => run.costUsd ?? null)),
    latencyMs: median(runs.map((run) => run.durationMs ?? null)),
  };
}

function median(values: readonly (number | null)[]): number | null {
  const known = values
    .filter((value): value is number => value !== null && Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  if (known.length === 0) return null;
  const middle = Math.floor(known.length / 2);
  return known.length % 2 === 0 ? (known[middle - 1]! + known[middle]!) / 2 : known[middle]!;
}

function scorerOf(kind: ScorerKind, config: Record<string, unknown>): Scorer {
  switch (kind) {
    case "ends_well":
      return { kind };
    case "judge_criteria":
      if (
        typeof config.criteria === "string" &&
        config.criteria.trim() &&
        config.criteria.length <= 5000
      )
        return { kind, criteria: config.criteria.trim() };
      break;
    case "expected_tool":
      if (typeof config.tool === "string" && config.tool.trim()) return { kind, tool: config.tool };
      break;
    case "max_self_corrections":
    case "max_latency_ms":
    case "max_cost_usd":
    case "max_tool_calls":
      if (typeof config.max === "number" && Number.isFinite(config.max) && config.max >= 0)
        return { kind, max: config.max };
      break;
  }
  throw new Error("task scorer configuration is invalid");
}
