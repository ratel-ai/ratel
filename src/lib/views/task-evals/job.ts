import { and, eq, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { jobs } from "@/lib/jobs/schema";
import { traceTurns } from "@/lib/ledger/schema";
import { getDb } from "@/lib/platform/db/client";
import { evalGateEnabledForActor } from "@/lib/views/eval-gate/gate";
import type { EvalDb } from "@/lib/views/eval-gate/runs";
import { taskEvalSets } from "@/lib/views/task-evals/schema";
import {
  type RefreshTaskEvalSetDeps,
  refreshTaskEvalSet,
  TASK_EVAL_ACTOR,
  TASK_EVAL_REFRESH_MS,
} from "./store";

type EnqueueDeps = Pick<RefreshTaskEvalSetDeps, "flagDeps" | "now"> & {
  db?: EvalDb;
  scheduled?: boolean;
};

/** Run a queued refresh. Scheduled jobs enforce the weekly limit after they acquire the set lock. */
export async function refreshTaskEvalSetJob(
  projectId: string,
  payload: unknown,
  deps: RefreshTaskEvalSetDeps = {},
) {
  if (
    !payload ||
    typeof payload !== "object" ||
    !("taskId" in payload) ||
    typeof payload.taskId !== "string" ||
    !payload.taskId.trim()
  ) {
    return { refreshed: false, reason: "invalid_payload" } as const;
  }
  return refreshTaskEvalSet(projectId, payload.taskId, {
    ...deps,
    scheduled: "scheduled" in payload && payload.scheduled === true,
  });
}

/** Queue one refresh. Explicit requests bypass the weekly limit and coalesce with pending work. */
export async function enqueueTaskEvalRefreshJob(
  projectId: string,
  taskId: string,
  deps: EnqueueDeps = {},
): Promise<{ id: string } | null> {
  const db = deps.db ?? getDb();
  if (!(await evalGateEnabledForActor(projectId, TASK_EVAL_ACTOR, db, deps.flagDeps))) return null;
  const scope = and(
    eq(jobs.projectId, projectId),
    eq(jobs.kind, "refresh_task_eval_set"),
    sql`${jobs.payload}->>'taskId' = ${taskId}`,
    sql`${jobs.status} in ('queued', 'running')`,
  );
  const [pending] = await db
    .select({ id: jobs.id, status: jobs.status })
    .from(jobs)
    .where(scope)
    .limit(1);
  if (pending) {
    if (!deps.scheduled && pending.status === "queued") {
      await db
        .update(jobs)
        .set({ payload: { taskId, scheduled: false } })
        .where(and(eq(jobs.id, pending.id), eq(jobs.status, "queued")));
    }
    return { id: pending.id };
  }
  const [job] = await db
    .insert(jobs)
    .values({
      projectId,
      kind: "refresh_task_eval_set",
      status: "queued",
      payload: { taskId, scheduled: deps.scheduled ?? false },
    })
    .returning({ id: jobs.id });
  return job!;
}

/** Queue due task sets after live scoring. No task refreshes more than once a week automatically. */
export async function enqueueDueTaskEvalSets(
  projectId: string,
  deps: EnqueueDeps = {},
): Promise<number> {
  const db = deps.db ?? getDb();
  if (!(await evalGateEnabledForActor(projectId, TASK_EVAL_ACTOR, db, deps.flagDeps))) return 0;
  const now = deps.now?.() ?? new Date();
  const due = await db
    .selectDistinct({ taskId: traceTurns.workflowId })
    .from(traceTurns)
    .leftJoin(
      taskEvalSets,
      and(eq(taskEvalSets.projectId, projectId), eq(taskEvalSets.taskId, traceTurns.workflowId)),
    )
    .where(
      and(
        eq(traceTurns.projectId, projectId),
        eq(traceTurns.status, "closed"),
        isNotNull(traceTurns.workflowId),
        lte(traceTurns.endedAt, now),
        or(
          isNull(taskEvalSets.refreshedAt),
          lte(taskEvalSets.refreshedAt, new Date(now.getTime() - TASK_EVAL_REFRESH_MS)),
        ),
      ),
    );
  let queued = 0;
  for (const row of due) {
    if (
      row.taskId !== null &&
      (await enqueueTaskEvalRefreshJob(projectId, row.taskId, { ...deps, db, scheduled: true }))
    )
      queued++;
  }
  return queued;
}
