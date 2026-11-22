import { getDb } from "@/lib/platform/db/client";
import { scorersFor } from "@/lib/views/task-scorers/store";
import type { Scorer } from "@/lib/views/task-scorers/types";

/** Each task's enabled scorers, by workflow id: what an eval of those tasks is held to before its own checks. */
export async function enabledTaskScorers(
  projectId: string,
  taskIds: Iterable<string>,
  db: ReturnType<typeof getDb> = getDb(),
): Promise<Map<string, Scorer[]>> {
  const out = new Map<string, Scorer[]>();
  for (const id of new Set(taskIds))
    out.set(
      id,
      (await scorersFor(projectId, id, db)).filter((scorer) => scorer.enabled),
    );
  return out;
}
