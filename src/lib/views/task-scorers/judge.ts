import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import { envNumber } from "@/lib/platform/env-number";
import { getLogger, runWithLogContext } from "@/lib/platform/logger";
import { projects } from "@/lib/platform/projects/schema";
import { describeSide } from "@/lib/views/eval-gate/judge";
import {
  DAILY_ORG_BUDGET_USD,
  estimateTokens,
  type JudgeModel,
  recordBudgetRefusal,
  resolveTaskJudge,
  SMALL_MAX_TOKENS,
  SpendMeter,
} from "@/lib/views/eval-gate/models";
import { recordedView } from "@/lib/views/eval-gate/simulate";
import { lockOrganizationSpend, organizationModelSpendSince } from "@/lib/views/eval-gate/store";
import type { RunRecord } from "@/lib/views/eval-gate/types";
import { SCORER_VERSION } from "@/lib/views/task-scorers/engine";
import { taskScoresDaily } from "@/lib/views/task-scorers/schema";
// Owned (ADR-0030): the task loop's spend joins the daily budget through the eval gate's seam.
import "@/lib/views/task-evals/spend";

export const TASK_JUDGE_SAMPLE = Math.floor(envNumber("TASK_JUDGE_SAMPLE", 20, (n) => n >= 0));
export const TASK_JUDGE_BUDGET_USD = envNumber("TASK_JUDGE_BUDGET_USD", 0.5, (n) => n >= 0);
export interface TaskJudgeDeps {
  judge?: JudgeModel | null;
  sample?: number;
  judgeBudgetUsd?: number;
  dailyBudgetUsd?: number;
}
const logger = getLogger("task-scorers/judge");

/** Judge today's live sample. The caller enforces the project flag. */
export async function judgeTaskSample(
  projectId: string,
  taskId: string,
  criteria: string,
  runs: readonly RunRecord[],
  now: Date,
  db: ReturnType<typeof getDb> = getDb(),
  deps: TaskJudgeDeps = {},
) {
  const judge = deps.judge === undefined ? resolveTaskJudge() : deps.judge;
  if (!judge) return;
  const day = now.toISOString().slice(0, 10);
  const scope = and(
    eq(taskScoresDaily.projectId, projectId),
    eq(taskScoresDaily.taskId, taskId),
    eq(taskScoresDaily.day, day),
    eq(taskScoresDaily.scorerKind, "judge_criteria"),
  );
  const held = await db.transaction(async (tx) => {
    // Owned (ADR-0030): the core has no organizations table; the advisory lock stands in.
    const [org] = await tx
      .select({ id: projects.organizationId })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (!org || !(await lockOrganizationSpend(projectId, tx)))
      throw new Error("The task project does not exist.");
    const [previous] = await tx.select().from(taskScoresDaily).where(scope);
    if (previous?.judgeSpend?.reserved) return null;
    const ids = previous?.judgeSpend?.runIds ?? [];
    const sample = Math.max(0, Math.floor(deps.sample ?? TASK_JUDGE_SAMPLE));
    const candidates = [...runs]
      .sort((a, b) => a.turnId.localeCompare(b.turnId))
      .filter((run) => !ids.includes(run.turnId))
      .slice(0, Math.max(0, sample - ids.length));
    if (!candidates.length) return null;
    const [spent] = await tx
      .select({
        usd: sql<string>`coalesce(sum((${taskScoresDaily.judgeSpend}->>'usd')::numeric), 0)`,
      })
      .from(taskScoresDaily)
      .innerJoin(projects, eq(projects.id, taskScoresDaily.projectId))
      .where(and(eq(projects.organizationId, org.id), eq(taskScoresDaily.day, day)));
    const allSpent = await organizationModelSpendSince(
      projectId,
      new Date(now.getTime() - 86_400_000),
      tx,
    );
    const cap = Math.max(
      0,
      Math.min(
        (deps.judgeBudgetUsd ?? TASK_JUDGE_BUDGET_USD) - Number(spent?.usd ?? 0),
        (deps.dailyBudgetUsd ?? DAILY_ORG_BUDGET_USD) - allSpent,
      ),
    );
    if (cap <= 0) {
      recordBudgetRefusal(judge, "eval_gate_task_judge", candidates.length);
      logger.info(
        {
          project_id: projectId,
          task_id: taskId,
          judged: 0,
          refused_budget: candidates.length,
          cost_usd: 0,
        },
        "task_judge_sampled",
      );
      return null;
    }
    const usd = previous?.judgeSpend?.usd ?? 0;
    // Persist the maximum charge and attempted IDs before any model call.
    const judgeSpend = {
      usd: usd + cap,
      runIds: [...ids, ...candidates.map((run) => run.turnId)],
      reserved: true,
    };
    await tx
      .insert(taskScoresDaily)
      .values({
        projectId,
        taskId,
        day,
        scorerKind: "judge_criteria",
        scorerVersion: SCORER_VERSION,
        n: previous?.n ?? 0,
        passed: previous?.passed ?? 0,
        judgeSpend,
      })
      .onConflictDoUpdate({
        target: [
          taskScoresDaily.projectId,
          taskScoresDaily.taskId,
          taskScoresDaily.day,
          taskScoresDaily.scorerKind,
        ],
        set: { judgeSpend },
      });
    return {
      candidates,
      cap,
      usd,
      organizationId: org.id,
      n: previous?.n ?? 0,
      passed: previous?.passed ?? 0,
      judgeSpend,
    };
  });
  if (!held) return;
  const meter = new SpendMeter(held.cap);
  let judged = 0;
  let passed = 0;
  let uncertain = false;
  for (const run of held.candidates) {
    const description = describeSide(recordedView(run, null));
    const reservation = await meter.reserve(judge.model, {
      inputTokens: 400 + estimateTokens(criteria, description),
      outputTokens: SMALL_MAX_TOKENS,
    });
    if (!reservation) {
      recordBudgetRefusal(judge, "eval_gate_task_judge");
      continue;
    }
    try {
      const result = await runWithLogContext(
        { project_id: projectId, org_id: held.organizationId },
        () => judge.judge({ criteria, run: description }),
      );
      meter.settle(reservation, judge.model, result.usage);
      judged++;
      if (result.pass) passed++;
    } catch (err) {
      logger.error(
        { err, project_id: projectId, task_id: taskId, turn_id: run.turnId },
        "task criteria judge failed",
      );
      // A provider error can still incur charges. Preserve the reservation.
      uncertain = true;
      break;
    }
  }
  await db
    .update(taskScoresDaily)
    .set({
      n: held.n + judged,
      passed: held.passed + passed,
      judgeSpend: {
        ...held.judgeSpend,
        usd: held.usd + (uncertain ? held.cap : meter.usd),
        reserved: false,
      },
    })
    .where(scope);
  logger.info(
    {
      project_id: projectId,
      task_id: taskId,
      judged,
      refused_budget: held.candidates.length - judged,
      cost_usd: uncertain ? held.cap : meter.usd,
    },
    "task_judge_sampled",
  );
}
