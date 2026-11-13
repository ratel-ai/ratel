import { and, desc, eq, gte, isNotNull, lt, lte, notExists, sql } from "drizzle-orm";
import {
  type BackgroundObservability,
  createBackgroundObservability,
} from "@/lib/jobs/observability";
import { jobs } from "@/lib/jobs/schema";
import { traceTurns } from "@/lib/ledger/schema";
import { getDb } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import { evalGateEnabledForActor } from "@/lib/views/eval-gate/gate";
import { type EvalDb, loadRuns } from "@/lib/views/eval-gate/runs";
import { recordedView } from "@/lib/views/eval-gate/simulate";
import type { RunRecord } from "@/lib/views/eval-gate/types";
import { enqueueDueTaskEvalSets } from "@/lib/views/task-evals/job";
import type { OrganizationFlagDeps } from "@/lib/views/task-evals/store";
import { SCORER_VERSION, scoreRun } from "@/lib/views/task-scorers/engine";
import { judgeTaskSample, type TaskJudgeDeps } from "@/lib/views/task-scorers/judge";
import { taskScorers, taskScoresDaily } from "@/lib/views/task-scorers/schema";
import { type DailyScore, scorersFor, upsertDailyScores } from "@/lib/views/task-scorers/store";
import type { Scorer } from "@/lib/views/task-scorers/types";

const logger = getLogger("task-scorers/job");
const SYSTEM_ACTOR = "system:task-scorers";
const DAY_MS = 86_400_000;
const RUN_LIMIT = 500;

export interface ScoreTasksJobDeps extends TaskJudgeDeps {
  db?: ReturnType<typeof getDb>;
  flagDeps?: OrganizationFlagDeps;
  now?: () => Date;
  observability?: Pick<BackgroundObservability, "trackSystemEvent">;
}

/** Score closed task runs by UTC day. Repeated jobs replace the current day's counts. */
export async function scoreTasksJob(projectId: string, deps: ScoreTasksJobDeps = {}) {
  const db = deps.db ?? getDb();
  if (!(await evalGateEnabledForActor(projectId, SYSTEM_ACTOR, db, deps.flagDeps))) {
    return { scored: false, reason: "gate_off" };
  }
  const startedAt = Date.now();
  const now = deps.now?.() ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const tasks = await db
    .select({
      taskId: traceTurns.workflowId,
      firstDay: sql<string>`min((${traceTurns.endedAt} at time zone 'UTC')::date)::text`,
    })
    .from(traceTurns)
    .where(
      and(
        eq(traceTurns.projectId, projectId),
        eq(traceTurns.status, "closed"),
        isNotNull(traceTurns.workflowId),
        lte(traceTurns.endedAt, now),
      ),
    )
    .groupBy(traceTurns.workflowId);
  const checkpoints = await db
    .select({ taskId: taskScoresDaily.taskId, day: sql<string>`max(${taskScoresDaily.day})` })
    .from(taskScoresDaily)
    .where(
      and(
        eq(taskScoresDaily.projectId, projectId),
        eq(taskScoresDaily.scorerKind, "overall"),
        lte(taskScoresDaily.day, today),
      ),
    )
    .groupBy(taskScoresDaily.taskId);
  const lastDays = new Map(checkpoints.map((row) => [row.taskId, row.day]));
  const counts = { tasks: 0, rows: 0, runs: 0, truncated: false };
  for (const task of tasks) {
    if (task.taskId === null) continue;
    const scorers = (await scorersFor(projectId, task.taskId, db)).filter(
      (scorer) => scorer.enabled,
    );
    const lastDay = lastDays.get(task.taskId);
    // The last reading can cover a partial day. Include it again to capture later runs.
    const firstDay = lastDay ?? task.firstDay;
    for (let day = firstDay; day <= today; day = nextDay(day)) {
      const candidates = await db
        .select({ id: traceTurns.id })
        .from(traceTurns)
        .where(
          and(
            eq(traceTurns.projectId, projectId),
            eq(traceTurns.workflowId, task.taskId),
            eq(traceTurns.status, "closed"),
            gte(traceTurns.endedAt, new Date(`${day}T00:00:00Z`)),
            lt(traceTurns.endedAt, new Date(`${nextDay(day)}T00:00:00Z`)),
            lte(traceTurns.endedAt, now),
          ),
        )
        .orderBy(desc(traceTurns.endedAt), desc(traceTurns.id))
        .limit(RUN_LIMIT + 1);
      counts.truncated ||= candidates.length > RUN_LIMIT;
      const runs = [
        ...(
          await loadRuns(
            projectId,
            candidates.slice(0, RUN_LIMIT).map((run) => run.id),
            db,
          )
        ).values(),
      ];
      const criteria = scorers.find((scorer) => scorer.kind === "judge_criteria");
      if (day === today && criteria?.kind === "judge_criteria")
        await judgeTaskSample(projectId, task.taskId, criteria.criteria, runs, now, db, deps);
      const scores = dailyScores(
        runs,
        scorers.filter((scorer) => scorer.kind !== "judge_criteria"),
      );
      await upsertDailyScores(projectId, task.taskId, day, scores, db);
      counts.rows += scores.length;
      counts.runs += runs.length;
    }
    counts.tasks++;
  }
  const orphans = await db
    .selectDistinct({ taskId: taskScorers.taskId })
    .from(taskScorers)
    .where(
      and(
        eq(taskScorers.projectId, projectId),
        notExists(
          db
            .select({ id: traceTurns.id })
            .from(traceTurns)
            .where(
              and(
                eq(traceTurns.projectId, projectId),
                eq(traceTurns.workflowId, taskScorers.taskId),
                gte(traceTurns.endedAt, new Date(now.getTime() - 7 * DAY_MS)),
                lte(traceTurns.startedAt, now),
              ),
            ),
        ),
      ),
    );
  if (orphans.length > 0) {
    logger.warn(
      { project_id: projectId, task_ids: orphans.map((task) => task.taskId) },
      "task_identity_orphaned",
    );
  }
  const fields = {
    project_id: projectId,
    ...counts,
    duration_ms: Math.max(0, Date.now() - startedAt),
  };
  logger.info(fields, "task_scores_written");
  await (deps.observability ?? createBackgroundObservability()).trackSystemEvent(
    "task_scores_written",
    SYSTEM_ACTOR,
    {
      object_action: "task_scores_written",
      ...fields,
    },
  );
  await enqueueDueTaskEvalSets(projectId, { db, flagDeps: deps.flagDeps, now: () => now });
  return { scored: true, ...counts, orphaned: orphans.length };
}

/** Queue live scoring after a signal run. Check the project's organization without a session. */
export async function enqueueScoreTasksJob(
  projectId: string,
  deps: { db?: EvalDb; flagDeps?: OrganizationFlagDeps } = {},
): Promise<{ id: string } | null> {
  const db = deps.db ?? getDb();
  if (!(await evalGateEnabledForActor(projectId, SYSTEM_ACTOR, db, deps.flagDeps))) return null;
  const [job] = await db
    .insert(jobs)
    .values({ projectId, kind: "score_tasks", status: "queued" })
    .returning({ id: jobs.id });
  return job!;
}

function dailyScores(runs: readonly RunRecord[], scorers: readonly Scorer[]): DailyScore[] {
  const scores: DailyScore[] = ["overall" as const, ...scorers.map((scorer) => scorer.kind)].map(
    (scorerKind) => ({
      scorerKind,
      scorerVersion: SCORER_VERSION,
      n: 0,
      passed: 0,
    }),
  );
  const byKind = new Map(scores.map((score) => [score.scorerKind, score]));
  const expectedTool = scorers.find((scorer) => scorer.kind === "expected_tool");
  for (const run of runs) {
    const results = scoreRun(
      recordedView(run, expectedTool?.kind === "expected_tool" ? expectedTool.tool : null),
      scorers,
    ).filter((result) => result.status !== "skip");
    for (const result of results) {
      const row = byKind.get(result.kind)!;
      row.n++;
      if (result.status === "pass") row.passed++;
    }
    if (results.length > 0) {
      scores[0]!.n++;
      if (results.every((result) => result.status === "pass")) scores[0]!.passed++;
    }
  }
  return scores;
}

function nextDay(day: string): string {
  return new Date(new Date(`${day}T00:00:00Z`).getTime() + DAY_MS).toISOString().slice(0, 10);
}
