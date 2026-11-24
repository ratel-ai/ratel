import { and, eq, gte, lt, sql } from "drizzle-orm";
import { traceTurnSteps, traceTurns } from "@/lib/ledger/schema";
import { getDb } from "@/lib/platform/db/client";
import type { PageDb, PageWindow } from "@/lib/views/health/hallucinations/page-queries";

/**
 * The tool check that needs no text: a tool that worked once exists, so a
 * call under its name asked for nothing made up. A name that never worked is
 * left open, not counted as a hallucination: it may be made up, or a real
 * tool that only failed. Used where the traces carry neither the tool name
 * the agent asked for nor error text (`uncheckedReason`).
 */
interface ToolNameRow {
  name: string;
  calls: number;
  worked: number;
}

export interface ToolNameCheck {
  calls: number;
  /** Calls under a name that worked at least once. */
  callsOnWorking: number;
}

export function toolNameCheck(rows: readonly ToolNameRow[]): ToolNameCheck {
  const count = (of: readonly ToolNameRow[]) => of.reduce((sum, row) => sum + row.calls, 0);
  return { calls: count(rows), callsOnWorking: count(rows.filter((row) => row.worked > 0)) };
}

const inWindow = (projectId: string, window: PageWindow) =>
  and(
    eq(traceTurns.projectId, projectId),
    eq(traceTurns.status, "closed"),
    gte(traceTurns.endedAt, window.from),
    lt(traceTurns.endedAt, window.to),
    eq(traceTurnSteps.kind, "invoke"),
    eq(traceTurnSteps.targetType, "tool"),
    sql`${traceTurnSteps.targetId} is not null`,
    // A call whose end was never seen says nothing either way.
    sql`${traceTurnSteps.outcome} in ('ok', 'error')`,
  );

/** Every tool name the window's closed turns called, with how often it worked. */
export async function loadToolNames(
  projectId: string,
  window: PageWindow,
  db: PageDb = getDb(),
): Promise<ToolNameRow[]> {
  return db
    .select({
      name: sql<string>`${traceTurnSteps.targetId}`,
      calls: sql<number>`count(*)`.mapWith(Number),
      worked: sql<number>`count(*) filter (where ${traceTurnSteps.outcome} = 'ok')`.mapWith(Number),
    })
    .from(traceTurnSteps)
    .innerJoin(traceTurns, eq(traceTurns.id, traceTurnSteps.turnId))
    .where(inWindow(projectId, window))
    .groupBy(traceTurnSteps.targetId);
}

/** Whether the window has a call that worked, so tools can be checked by name. */
export async function hasWorkingTool(
  projectId: string,
  window: PageWindow,
  db: PageDb = getDb(),
): Promise<boolean> {
  const rows = await db
    .select({ one: sql`1` })
    .from(traceTurnSteps)
    .innerJoin(traceTurns, eq(traceTurns.id, traceTurnSteps.turnId))
    .where(and(inWindow(projectId, window), eq(traceTurnSteps.outcome, "ok")))
    .limit(1);
  return rows.length > 0;
}
