import { listPivots, type PivotsDb } from "@/lib/ingest/pivots/store";
import { getDb } from "@/lib/platform/db/client";
import type { PivotFilterOption } from "@/lib/synthesis/traces/v2/filters";

/**
 * The pivots the Sessions and Turns bars filter by (RC-885): the project's
 * configured pivots in display order, keys and labels only. None configured,
 * none listed, and the pages are as without pivots.
 */
export async function loadPivotFilterOptions(
  projectId: string,
  list: (projectId: string) => Promise<readonly PivotFilterOption[]> = (id) =>
    listPivots(id, getDb() as PivotsDb),
): Promise<readonly PivotFilterOption[]> {
  const pivots = await list(projectId);
  return pivots.map(({ key, label }) => ({ key, label }));
}
