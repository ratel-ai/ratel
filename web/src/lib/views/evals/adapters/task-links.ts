import { and, eq, isNotNull } from "drizzle-orm";
import { traceTurns } from "@/lib/ledger/schema";
import { getDb } from "@/lib/platform/db/client";
import { sandboxOfTask } from "@/lib/readings/trace-signals/workflows/sandbox-tasks";
import { listSandboxVersions } from "@/lib/views/sandboxes";
import { scorersFor } from "@/lib/views/task-scorers/store";
import { taskNames } from "@/lib/views/tasks/model";
import { loadTasksInputs } from "@/lib/views/tasks/page-model";
import { scorersOfTask, type TaskRef } from "../domain/eval-target";
import type { TaskLinks } from "../ports/task-links";

type Db = Pick<ReturnType<typeof getDb>, "select">;

/** An OTLP turn is the run of one trace: its key is `otlp:<trace id>`. */
const OTLP_KEY = "otlp:";
const LATEST_OF = 20;

/** The reads of `TaskLinks` over the real database and the tasks module. */
export function createTaskLinks(db: Db = getDb()): TaskLinks {
  const named = async (projectId: string, ids: ReadonlyArray<string | null>) => {
    const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
    if (wanted.length === 0) return [];
    const { stored, labels, names } = await loadTasksInputs(projectId);
    const known = taskNames(stored, labels, names);
    // The task of a sandbox is named by its sandbox until a signal run names it.
    return wanted.map((id): TaskRef => ({ id, name: known.get(id) ?? sandboxOfTask(id) ?? id }));
  };
  return {
    async tasksOfTurn(projectId, turnId) {
      const rows = await db
        .select({ taskId: traceTurns.workflowId })
        .from(traceTurns)
        .where(and(eq(traceTurns.projectId, projectId), eq(traceTurns.id, turnId)));
      return named(
        projectId,
        rows.map(({ taskId }) => taskId),
      );
    },
    async tasksOfTrace(projectId, traceId) {
      const rows = await db
        .select({ taskId: traceTurns.workflowId })
        .from(traceTurns)
        .where(
          and(
            eq(traceTurns.projectId, projectId),
            eq(traceTurns.turnKey, `${OTLP_KEY}${traceId.toLowerCase()}`),
            isNotNull(traceTurns.workflowId),
          ),
        );
      return named(
        projectId,
        rows.map(({ taskId }) => taskId),
      );
    },
    async defaultScorers(projectId, taskId) {
      const scorers = await scorersFor(projectId, taskId);
      return scorersOfTask(scorers.filter((scorer) => scorer.enabled !== false));
    },
    async lastSandbox(projectId) {
      const versions = await listSandboxVersions(projectId, LATEST_OF);
      return versions.find(({ status }) => status === "ready")?.name ?? null;
    },
  };
}
