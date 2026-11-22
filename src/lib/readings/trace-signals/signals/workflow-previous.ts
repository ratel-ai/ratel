import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import { reportServerException } from "@/lib/platform/telemetry";
import { traceSignalRuns } from "@/lib/readings/trace-signals/schema";
import type { WorkflowCore } from "@/lib/readings/trace-signals/workflows/types";

/**
 * Last run's workflows, as much of them as carrying ids over needs: each
 * one's id and core tools, read from the latest completed run's
 * `summary.workflows.items` (only that JSON path, never the whole summary).
 * Stored JSON is untrusted: anything malformed is skipped, and a failed read
 * is logged, reported and treated as no previous workflows.
 */

const logger = getLogger("trace-signals/workflow-previous");

export type PreviousWorkflowsDb = Pick<ReturnType<typeof getDb>, "select">;

/** Items read at most; a stored run holds a dozen. */
export const MAX_PREVIOUS_WORKFLOWS = 64;
const MAX_ID_LENGTH = 128;

const isToolId = (value: unknown): value is string => typeof value === "string" && value.length > 0;

function parseItem(item: unknown): WorkflowCore | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const { id, coreTools } = item as { id?: unknown; coreTools?: unknown };
  if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_LENGTH) return null;
  if (!Array.isArray(coreTools) || coreTools.length === 0 || !coreTools.every(isToolId))
    return null;
  return { id, coreTools: [...new Set(coreTools)].sort() };
}

/** The id and core tools of each well-formed stored item; duplicate ids keep the first. */
export function parsePreviousWorkflows(items: unknown): WorkflowCore[] {
  if (!Array.isArray(items)) return [];
  const seen = new Set<string>();
  return items.slice(0, MAX_PREVIOUS_WORKFLOWS).flatMap((item) => {
    const core = parseItem(item);
    if (!core || seen.has(core.id)) return [];
    seen.add(core.id);
    return [core];
  });
}

export async function loadPreviousWorkflows(
  projectId: string,
  db: PreviousWorkflowsDb = getDb(),
): Promise<WorkflowCore[]> {
  try {
    const [row] = await db
      .select({ items: sql<unknown>`${traceSignalRuns.summary} -> 'workflows' -> 'items'` })
      .from(traceSignalRuns)
      .where(and(eq(traceSignalRuns.projectId, projectId), eq(traceSignalRuns.status, "completed")))
      .orderBy(desc(traceSignalRuns.createdAt))
      .limit(1);
    // jsonb arrives parsed (node-postgres and PGlite both); a JSON string there is junk, not text to parse.
    return parsePreviousWorkflows(row?.items ?? null);
  } catch (err) {
    logger.error({ err, project_id: projectId }, "previous workflows unreadable for trace signals");
    reportServerException(err, "system:trace-signals", {
      project_id: projectId,
      operation: "trace_signals_load_previous_workflows",
    });
    return [];
  }
}
