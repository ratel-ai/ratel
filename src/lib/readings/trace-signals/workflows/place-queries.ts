import { and, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { traceTurns } from "@/lib/ledger/schema";
import { getDb } from "@/lib/platform/db/client";

/**
 * Writes a signal run's placement (`placeRuns`) to `trace_turns.workflow_id`,
 * so every page that lists a task's runs, and every job after the signal run
 * (names, topics, self-corrections, Tool craft's reading), reads the same
 * answer. Only the closed runs ending in the run's window change: each gets
 * its task, and one the run placed in none (or did not read: a guessed run
 * once exact ones carry the reading, a run past the turn cap) loses a stale
 * one. Runs outside the window keep what an earlier run wrote.
 *
 * Idempotent: the window's current values are read first and only rows whose
 * value changes are written, so the same reading run twice writes nothing.
 */

export type PlacementDb = Pick<ReturnType<typeof getDb>, "transaction">;

export interface PlacementWrite {
  window: { start: Date; end: Date };
  /** Each read run's task, or null; runs absent from it belong to none. */
  placement: ReadonlyMap<string, string | null>;
}

export interface PlacementWriteResult {
  /** Runs placed in a task by this reading. */
  placed: number;
  /** Rows whose task was written, and rows whose stale task was cleared. */
  set: number;
  cleared: number;
}

const CHUNK = 1_000;

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

export async function writeTaskPlacement(
  projectId: string,
  input: PlacementWrite,
  db: PlacementDb = getDb(),
): Promise<PlacementWriteResult> {
  return db.transaction(async (tx) => {
    const current = await tx
      .select({ id: traceTurns.id, workflowId: traceTurns.workflowId })
      .from(traceTurns)
      .where(
        and(
          eq(traceTurns.projectId, projectId),
          isNotNull(traceTurns.workflowId),
          eq(traceTurns.status, "closed"),
          gte(traceTurns.endedAt, input.window.start),
          lt(traceTurns.endedAt, input.window.end),
        ),
      );
    const now = new Map(current.map((row) => [row.id, row.workflowId]));
    const sets: [string, string][] = [];
    let placed = 0;
    for (const [runId, taskId] of input.placement) {
      if (taskId === null) continue;
      placed += 1;
      if (now.get(runId) !== taskId) sets.push([runId, taskId]);
    }
    const clears = current
      .filter((row) => (input.placement.get(row.id) ?? null) === null)
      .map((row) => row.id);

    for (const chunk of chunks(sets)) {
      const values = sql.join(
        chunk.map(([runId, taskId]) => sql`(${runId}::uuid, ${taskId}::text)`),
        sql`, `,
      );
      await tx.execute(sql`
        update ${traceTurns} as t set workflow_id = v.workflow_id
        from (values ${values}) as v(id, workflow_id)
        where t.project_id = ${projectId} and t.id = v.id
      `);
    }
    for (const chunk of chunks(clears)) {
      await tx
        .update(traceTurns)
        .set({ workflowId: null })
        .where(and(eq(traceTurns.projectId, projectId), inArray(traceTurns.id, chunk)));
    }
    return { placed, set: sets.length, cleared: clears.length };
  });
}
