import { and, desc, eq } from "drizzle-orm";
import { traceTurns } from "@/lib/ledger/schema";
import { getDb } from "@/lib/platform/db/client";
import { sandboxOfTask } from "@/lib/readings/trace-signals/workflows/sandbox-tasks";
import { taskNames } from "@/lib/views/tasks/model";
import { loadTasksInputs } from "@/lib/views/tasks/page-model";

type Db = Pick<ReturnType<typeof getDb>, "select">;

export type PickerTurn = {
  turnId: string;
  taskId: string | null;
  taskName: string | null;
  endedAt: string;
  failed: boolean;
};

export type PickerOptions = {
  /** The newest closed turns, the newest first. */
  turns: PickerTurn[];
  /** The tasks of the project, by name. */
  tasks: Array<{ id: string; name: string }>;
};

/** The turns that the trace picker shows. */
const PICKER_TURNS = 30;

/**
 * What the dataset dialogs offer to pick: the newest closed turns of the project and its tasks. A
 * turn is shown by its time, its task and whether it failed: its text is read only when it becomes
 * a row.
 */
export async function loadPickerOptions(
  projectId: string,
  db: Db = getDb(),
): Promise<PickerOptions> {
  const [turns, inputs] = await Promise.all([
    db
      .select({
        id: traceTurns.id,
        workflowId: traceTurns.workflowId,
        errorCount: traceTurns.errorCount,
        abandoned: traceTurns.abandoned,
        endedAt: traceTurns.endedAt,
      })
      .from(traceTurns)
      .where(and(eq(traceTurns.projectId, projectId), eq(traceTurns.status, "closed")))
      .orderBy(desc(traceTurns.endedAt), desc(traceTurns.id))
      .limit(PICKER_TURNS),
    loadTasksInputs(projectId),
  ]);
  const names = taskNames(inputs.stored, inputs.labels, inputs.names);
  const nameOf = (id: string) => names.get(id) ?? sandboxOfTask(id) ?? id;
  return {
    turns: turns.map((turn) => ({
      turnId: turn.id,
      taskId: turn.workflowId,
      taskName: turn.workflowId ? nameOf(turn.workflowId) : null,
      endedAt: turn.endedAt.toISOString(),
      failed: turn.errorCount > 0 || turn.abandoned === true,
    })),
    tasks: [...names]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}
