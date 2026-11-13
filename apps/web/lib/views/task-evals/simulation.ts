import { and, eq, inArray, lt, sql } from "drizzle-orm";
import {
  type BackgroundObservability,
  createBackgroundObservability,
} from "@/lib/jobs/observability";
import { jobs } from "@/lib/jobs/schema";
import { getDb } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import { projects } from "@/lib/platform/projects/schema";
import { parseChange } from "@/lib/views/eval-gate/change";
import { EVAL_GATE_OFF_ERROR, evalGateEnabledForActor } from "@/lib/views/eval-gate/gate";
import type { EvalModels } from "@/lib/views/eval-gate/models";
import { resolveFixChange } from "@/lib/views/eval-gate/seams";
import { type FixContext, loadFixContext, resolveFixProject } from "@/lib/views/eval-gate/service";
import {
  lockOrganizationSpend,
  organizationModelSpendSince,
  STALE_EVAL_RUN_MS,
} from "@/lib/views/eval-gate/store";
import { type TaskEvalRunRow, taskEvalRuns } from "@/lib/views/task-evals/schema";
import { simulationInputKey } from "@/lib/views/task-evals/simulation-view";
import {
  type OrganizationFlagDeps,
  refreshTaskEvalSet,
  taskEvalSetFor,
} from "@/lib/views/task-evals/store";
// Owned (ADR-0030): the task loop's spend joins the daily budget through the eval gate's seam.
import "./spend";
import { SCORER_VERSION } from "@/lib/views/task-scorers/engine";
import { scorersFor } from "@/lib/views/task-scorers/store";

export interface TaskSimulationDeps {
  db?: ReturnType<typeof getDb>;
  flagDeps?: OrganizationFlagDeps;
  loadFix?: (projectId: string, fixId: string) => Promise<FixContext | null>;
  models?: EvalModels;
  dailyBudgetUsd?: number;
  replayBudgetUsd?: number;
  judgeBudgetUsd?: number;
  now?: () => Date;
  observability?: Pick<BackgroundObservability, "trackSystemEvent">;
}

export interface TaskSimulationOptions {
  projectId?: string;
  actor?: string;
  trigger?: "manual" | "mcp";
  deps?: TaskSimulationDeps;
}

const logger = getLogger("task-evals/simulation");

/** Queue the fix once for each task. The database commits each run with its job. */
export async function runTaskSimulation(fixId: string, options: TaskSimulationOptions = {}) {
  const deps = options.deps ?? {};
  const db = deps.db ?? getDb();
  const projectId = options.projectId ?? (await resolveFixProject(fixId, db));
  if (!projectId) throw new Error("No project has this fix.");
  const actor =
    options.actor ?? (options.trigger === "mcp" ? `project:${projectId}` : "system:task-evals");
  if (!(await evalGateEnabledForActor(projectId, actor, db, deps.flagDeps)))
    throw new Error(EVAL_GATE_OFF_ERROR);
  const ctx = await (deps.loadFix ?? loadFixContext)(projectId, fixId);
  if (!ctx || ctx.projectId !== projectId)
    throw new Error("This fix does not exist in the project.");
  // Owned (ADR-0030): the gate is FF_EVAL_GATE, so the flag deps are the environment it reads.
  const resolved = await resolveFixChange(projectId, ctx.fix, { db, actor, env: deps.flagDeps });
  if (resolved.status === "drafting")
    return { status: "drafting" as const, runs: [] as TaskEvalRunRow[] };
  if (resolved.status !== "ready")
    throw new Error(resolved.change.unsupportedReason ?? "This fix cannot be simulated.");
  const runs: TaskEvalRunRow[] = [];
  for (const taskId of new Set(ctx.fix.subject.tasks.map((task) => task.id))) {
    if (!(await taskEvalSetFor(projectId, taskId, db)).set?.refreshedAt) {
      const refreshed = await refreshTaskEvalSet(projectId, taskId, { ...deps, db, actor });
      if (!refreshed.refreshed) throw new Error("The task eval set could not be refreshed.");
    }
    const { cases } = await taskEvalSetFor(projectId, taskId, db);
    const scorers = (await scorersFor(projectId, taskId, db)).filter((scorer) => scorer.enabled);
    const inputKey = simulationInputKey(
      resolved.change,
      cases.filter((item) => item.fixId === null || item.fixId === ctx.fix.id),
      scorers,
    );
    const run = await db.transaction(async (tx) => {
      const scope = and(
        eq(taskEvalRuns.projectId, projectId),
        eq(taskEvalRuns.fixId, ctx.fix.id),
        eq(taskEvalRuns.taskId, taskId),
        eq(taskEvalRuns.kind, "simulation"),
        inArray(taskEvalRuns.status, ["queued", "running"]),
      );
      const now = deps.now?.() ?? new Date();
      const expired = await tx
        .update(taskEvalRuns)
        .set({ status: "failed", error: "The simulation timed out.", finishedAt: now })
        .where(
          and(
            scope,
            lt(
              sql`coalesce(${taskEvalRuns.startedAt}, ${taskEvalRuns.createdAt})`,
              new Date(now.getTime() - STALE_EVAL_RUN_MS),
            ),
          ),
        )
        .returning({ id: taskEvalRuns.id });
      for (const stale of expired)
        logger.warn(
          { run_id: stale.id, project_id: projectId, task_id: taskId },
          "task_eval_run_timed_out",
        );
      const [created] = await tx
        .insert(taskEvalRuns)
        .values({
          projectId,
          fixId: ctx.fix.id,
          taskId,
          scorerVersion: SCORER_VERSION,
          createdBy: actor,
          trigger: options.trigger ?? "manual",
          change: { ...resolved.change, kind: ctx.fix.kind, inputKey, scorers },
          createdAt: now,
        })
        .onConflictDoNothing()
        .returning();
      if (created) {
        await tx
          .insert(jobs)
          .values({ projectId, kind: "simulate_task_eval", payload: { runId: created.id } });
        return created;
      }
      const [pending] = await tx.select().from(taskEvalRuns).where(scope).limit(1);
      if (!pending) throw new Error("The pending task simulation does not exist.");
      return pending;
    });
    runs.push(run);
  }
  await (deps.observability ?? createBackgroundObservability()).trackSystemEvent(
    "task_eval_simulation_requested",
    actor,
    {
      object_action: "task_eval_simulation_requested",
      project_id: projectId,
      fix_id: ctx.fix.id,
      task_count: runs.length,
    },
  );
  return { status: "queued" as const, runs };
}

/** Reserve model spend under the same organization lock as fix drafts. */
export async function reserveTaskSimulation(
  run: TaskEvalRunRow,
  capUsd: number,
  dailyBudgetUsd: number,
  deps: TaskSimulationDeps,
) {
  const db = deps.db ?? getDb();
  return db.transaction(async (tx) => {
    // Owned (ADR-0030): the core has no organizations table; the advisory lock stands in.
    const [org] = await tx
      .select({ id: projects.organizationId })
      .from(projects)
      .where(eq(projects.id, run.projectId));
    if (!org || !(await lockOrganizationSpend(run.projectId, tx)))
      throw new Error("The simulation project does not exist.");
    const now = deps.now?.() ?? new Date();
    const spent = await organizationModelSpendSince(
      run.projectId,
      new Date(now.getTime() - 86_400_000),
      tx,
    );
    const reserved = Math.max(0, Math.min(capUsd, dailyBudgetUsd - spent));
    const [claimed] = await tx
      .update(taskEvalRuns)
      .set({ status: "running", startedAt: now, spend: { usd: reserved, reserved: true } })
      .where(and(eq(taskEvalRuns.id, run.id), eq(taskEvalRuns.status, "queued")))
      .returning();
    return claimed
      ? {
          run: claimed,
          dailyLeftUsd: reserved,
          organizationId: org.id,
          change: parseChange(claimed.change),
        }
      : null;
  });
}
