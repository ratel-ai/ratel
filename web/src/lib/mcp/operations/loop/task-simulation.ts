import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import type { LineageRef } from "@/lib/views/lineage/types";
import { type TaskEvalRunRow, taskEvalRuns } from "@/lib/views/task-evals/schema";
import { topLevelTasksHref } from "@/lib/views/tasks/paths";

const POLL_SECONDS = 20;

/** Read the latest simulation for each task. Exclude post-shipment measures. */
export async function latestTaskSimulations(
  projectId: string,
  fixId: string,
  db: ReturnType<typeof getDb> = getDb(),
) {
  return db
    .selectDistinctOn([taskEvalRuns.taskId])
    .from(taskEvalRuns)
    .where(
      and(
        eq(taskEvalRuns.projectId, projectId),
        eq(taskEvalRuns.fixId, fixId),
        eq(taskEvalRuns.kind, "simulation"),
      ),
    )
    .orderBy(taskEvalRuns.taskId, desc(taskEvalRuns.createdAt), desc(taskEvalRuns.id));
}

/** Keep each task's scores separate. A pending or unreliable run has no comparison. */
export function taskEvalData(
  projectId: string,
  fixId: string,
  runs: readonly TaskEvalRunRow[],
  source: LineageRef,
  requestedStatus?: "drafting" | "queued",
) {
  const tasks = runs.map((run) => {
    const count = Number(run.methods?.replay ?? 0) + Number(run.methods?.rerank ?? 0);
    const simulated = run.status === "completed" && count > 0 && run.verdict !== "unreliable";
    const href = `${topLevelTasksHref(projectId, run.taskId)}/simulations/${encodeURIComponent(fixId)}`;
    return {
      id: run.id,
      taskId: run.taskId,
      status: run.status,
      scorerVersion: run.scorerVersion,
      simulated,
      runs: count,
      cases: run.caseCount,
      fixCases: run.fixCaseCount,
      before: simulated ? run.before : null,
      after: simulated ? run.after : null,
      verdict: run.status === "queued" || run.status === "running" ? "pending" : run.verdict,
      breakdown: simulated ? run.breakdown : null,
      fidelity: run.methods?.fidelity ?? null,
      reasons: run.methods?.reasons ?? [],
      error: run.error,
      href,
      source,
    };
  });
  const status =
    requestedStatus === "drafting"
      ? "drafting"
      : tasks.some((task) => task.status === "running")
        ? "running"
        : tasks.some((task) => task.status === "queued")
          ? "queued"
          : tasks.some((task) => task.status === "failed")
            ? "failed"
            : tasks.length === 0
              ? "queued"
              : "completed";
  const pending = status === "queued" || status === "running";
  const simulated =
    status === "completed" && tasks.length > 0 && tasks.every((task) => task.simulated);
  const verdicts = new Set(tasks.map((task) => task.verdict));
  const hint =
    status === "drafting"
      ? "The draft job is queued. Call get_fix to read the draft status. Call run_eval when the draft status is ready."
      : pending
        ? `Call get_eval with this fixId every ${POLL_SECONDS} seconds until the status is completed or failed. Do not call run_eval again while it runs.`
        : "Read each task's result and error. Call mark_fix_shipped when the fix is live.";
  return {
    eval: {
      id: tasks[0]?.id ?? null,
      kind: "task_simulation",
      fixId,
      status,
      simulated,
      runs: tasks.reduce((total, task) => total + task.runs, 0),
      cases: tasks.reduce((total, task) => total + task.cases + task.fixCases, 0),
      before: null,
      after: null,
      verdict:
        pending || status === "drafting"
          ? "pending"
          : verdicts.size === 1
            ? tasks[0]!.verdict
            : "mixed",
      tasks,
      href: tasks[0]?.href ?? topLevelTasksHref(projectId),
      source,
      ...(pending ? { pollAfterSeconds: POLL_SECONDS } : {}),
    },
    hint,
    refs: tasks.map(
      (task): LineageRef => ({ stage: "improve", kind: "eval", id: task.id, href: task.href }),
    ),
  };
}
