import { and, desc, eq, isNotNull, ne, sql } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import { loadRuns } from "@/lib/views/eval-gate/runs";
import { evals } from "@/lib/views/evals/schema";
import { runScores, scorers } from "@/lib/views/scorers/schema";
import type { LowReading } from "./candidates";

/**
 * RC-616: the reads behind score-based suggestions: the task's live runs that
 * a scorer read under its good threshold, and each run's tool path.
 */

type Db = ReturnType<typeof getDb>;

/** What a run did: the tools it called, in order, and when it ended. */
export interface RunPath {
  toolPath: string[];
  endedAt: Date;
}

export interface LowRun {
  turnId: string;
  lows: LowReading[];
  /** When the newest of its low readings was taken. */
  scoredAt: Date;
}

/** At most this many low readings are read per task: the worst ones. */
const READING_POOL = 200;

/**
 * Each run of the task with a reading under its scorer's good threshold, by
 * an enabled task scorer at its current version. Runs that already made an
 * eval in the project (any status) are left out, so a removed one never returns.
 */
export async function loadLowRuns(
  projectId: string,
  taskId: string,
  db: Db = getDb(),
): Promise<LowRun[]> {
  const rows = await db
    .select({
      turnId: runScores.turnId,
      value: runScores.value,
      scoredAt: runScores.scoredAt,
      scorerId: scorers.id,
      scorerName: scorers.name,
      threshold: scorers.goodThreshold,
    })
    .from(runScores)
    .innerJoin(scorers, eq(scorers.id, runScores.scorerId))
    .where(
      and(
        eq(runScores.projectId, projectId),
        eq(scorers.projectId, projectId),
        eq(scorers.taskId, taskId),
        eq(scorers.scope, "task"),
        eq(scorers.enabled, true),
        eq(runScores.scorerVersion, scorers.version),
        isNotNull(runScores.turnId),
        ne(runScores.status, "skip"),
        isNotNull(runScores.value),
        sql`${runScores.value} < ${scorers.goodThreshold}`,
        sql`${runScores.turnId} not in (select ${evals.sourceTurnId} from ${evals} where ${evals.projectId} = ${projectId} and ${evals.sourceTurnId} is not null)`,
      ),
    )
    .orderBy(desc(sql`${scorers.goodThreshold} - ${runScores.value}`), desc(runScores.scoredAt))
    .limit(READING_POOL);
  const out = new Map<string, LowRun>();
  for (const row of rows) {
    const run = out.get(row.turnId!) ?? { turnId: row.turnId!, lows: [], scoredAt: row.scoredAt };
    run.lows.push({
      scorerId: row.scorerId,
      scorerName: row.scorerName,
      value: row.value!,
      threshold: row.threshold,
    });
    if (row.scoredAt > run.scoredAt) run.scoredAt = row.scoredAt;
    out.set(run.turnId, run);
  }
  return [...out.values()];
}

/** Each run's tool path, from its recorded steps. A run with no steps is left out. */
export async function loadRunPaths(
  projectId: string,
  turnIds: readonly string[],
  db: Db = getDb(),
): Promise<Map<string, RunPath>> {
  const runs = await loadRuns(projectId, turnIds, db);
  return new Map(
    [...runs.values()].map((run) => [
      run.turnId,
      {
        toolPath: run.steps
          .filter((step) => step.kind === "invoke")
          .sort((a, b) => a.ordinal - b.ordinal)
          .map((step) => step.targetId),
        endedAt: new Date(run.endedAt ?? run.startedAt),
      },
    ]),
  );
}
