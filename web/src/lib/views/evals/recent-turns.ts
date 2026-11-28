import { and, desc, eq } from "drizzle-orm";
import { traceTurns } from "@/lib/ledger/schema";
import type { getDb } from "@/lib/platform/db/client";
import { preview } from "./page-model";

/**
 * The trace picker of the Datasets and Evals pages: the newest closed turns of the project, each
 * with its time, its task, its tools and whether it failed. The ask is captured text: it is read
 * only when the project lets Ratel read captured text.
 */
export type RecentTurn = {
  turnId: string;
  endedAt: string;
  taskId: string | null;
  tools: number;
  failed: boolean;
  /** The ask, cut. Null when it is withheld or there is none. */
  ask: string | null;
};

/** The turns that the picker lists. */
export const PICKER_TURNS = 25;
/** Turns whose ask is read at the same time. */
const PARALLEL = 5;

export async function recentTurns(
  projectId: string,
  {
    db,
    readContent,
    loadAsk,
    limit = PICKER_TURNS,
  }: {
    db: Pick<ReturnType<typeof getDb>, "select">;
    readContent: boolean;
    /** The ask of a turn: captured text. */
    loadAsk: (projectId: string, turnId: string) => Promise<string | null>;
    limit?: number;
  },
): Promise<RecentTurn[]> {
  const rows = await db
    .select({
      id: traceTurns.id,
      endedAt: traceTurns.endedAt,
      workflowId: traceTurns.workflowId,
      distinctTools: traceTurns.distinctTools,
      errorCount: traceTurns.errorCount,
      abandoned: traceTurns.abandoned,
    })
    .from(traceTurns)
    .where(and(eq(traceTurns.projectId, projectId), eq(traceTurns.status, "closed")))
    .orderBy(desc(traceTurns.endedAt), desc(traceTurns.id))
    .limit(limit);
  const asks: Array<string | null> = new Array(rows.length).fill(null);
  if (readContent) {
    let next = 0;
    const lane = async () => {
      for (let index = next++; index < rows.length; index = next++) {
        const row = rows[index];
        const ask = row ? await loadAsk(projectId, row.id).catch(() => null) : null;
        asks[index] = ask === null ? null : preview(ask);
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, lane));
  }
  return rows.map((row, index) => ({
    turnId: row.id,
    endedAt: row.endedAt.toISOString(),
    taskId: row.workflowId,
    tools: row.distinctTools,
    failed: row.errorCount > 0 || row.abandoned === true,
    ask: asks[index] ?? null,
  }));
}
