import { and, desc, eq } from "drizzle-orm";
import { traceTurns } from "@/lib/ledger/schema";
import { getDb } from "@/lib/platform/db/client";
import { type EvalDb, loadRuns } from "@/lib/views/eval-gate/runs";
import { defaultScorers, type TaskStats } from "@/lib/views/task-scorers/defaults";
import { SCORER_VERSION } from "@/lib/views/task-scorers/engine";
import { selfCorrectionsOf } from "@/lib/views/task-scorers/outcome";
import type { Scorer } from "@/lib/views/task-scorers/types";

export type TaskScorer = Scorer & {
  enabled: boolean;
  source: "default" | "user";
  version: number;
};

const DEFAULT_RUN_LIMIT = 500;

/** A task's checks, measured on its own closed runs: what a simulation of a fix is graded with. */
export async function scorersFor(
  projectId: string,
  taskId: string,
  db: EvalDb = getDb(),
): Promise<TaskScorer[]> {
  const stats = await taskStatsFor(projectId, taskId, db);
  return defaultScorers(stats).map((scorer) => ({
    ...scorer,
    enabled: true,
    source: "default",
    version: SCORER_VERSION,
  }));
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
