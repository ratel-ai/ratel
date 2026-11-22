import { and, asc, eq } from "drizzle-orm";
import type { getDb } from "@/lib/platform/db/client";
import { taskSegments } from "@/lib/readings/trace-signals/schema";
import { loadWorkflowLabels } from "@/lib/readings/trace-signals/workflows/label-queries";
import { workflowDisplayName } from "@/lib/readings/trace-signals/workflows/name";
import { parseStoredWorkflows } from "@/lib/views/health/workflows-view";
import { loadLatestTasksRun } from "@/lib/views/tasks/queries";
import type { BandSegment } from "@/lib/views/tasks/session-bands";
import { tokenStepLabel } from "@/lib/views/tasks/step-kind";

/**
 * One session's task segments (`task_segments`, typed steps) in time order,
 * each with its task's name: the written label, else the task's steps from
 * the latest reading, else null. Ids and names only.
 */

type SegmentsDb = Pick<ReturnType<typeof getDb>, "select">;

export type NamedSegment = BandSegment & { label: string | null };

export async function loadSessionSegments(
  projectId: string,
  sessionId: string,
  db: SegmentsDb,
): Promise<NamedSegment[]> {
  const segments = await db
    .select({
      id: taskSegments.id,
      workflowId: taskSegments.workflowId,
      startTurnId: taskSegments.startTurnId,
      startOrdinal: taskSegments.startOrdinal,
      endTurnId: taskSegments.endTurnId,
      endOrdinal: taskSegments.endOrdinal,
    })
    .from(taskSegments)
    .where(and(eq(taskSegments.projectId, projectId), eq(taskSegments.sessionId, sessionId)))
    .orderBy(asc(taskSegments.startedAt));
  if (segments.length === 0) return [];
  const names = await loadTaskNames(
    projectId,
    [...new Set(segments.map((segment) => segment.workflowId))],
    db,
  );
  return segments.map((segment) => ({ ...segment, label: names.get(segment.workflowId) ?? null }));
}

async function loadTaskNames(
  projectId: string,
  ids: readonly string[],
  db: SegmentsDb,
): Promise<Map<string, string>> {
  const labels = await loadWorkflowLabels(projectId, db);
  const out = new Map<string, string>();
  for (const id of ids) {
    const label = labels.get(id);
    if (label) out.set(id, label.name);
  }
  if (out.size === ids.length) return out;
  const run = await loadLatestTasksRun(projectId, db);
  for (const item of parseStoredWorkflows(run?.workflows)?.items ?? []) {
    if (!ids.includes(item.id) || out.has(item.id)) continue;
    const names = new Map(
      item.typicalOrder.map((token) => [token, tokenStepLabel(token, new Map())]),
    );
    out.set(
      item.id,
      workflowDisplayName({ id: item.id, typicalOrder: item.typicalOrder }, names, labels),
    );
  }
  return out;
}
