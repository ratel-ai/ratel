import { and, asc, eq, sql } from "drizzle-orm";
import { projectPivots } from "@/lib/ingest/pivots/schema";
import type { getDb } from "@/lib/platform/db/client";
import { PIVOT_LIMIT, type Pivot } from "./model";

/**
 * The DB adapter of a project's pivots (`project_pivots`, RC-881). Every
 * statement is scoped to one project. The rules live in `./model`.
 */

export type PivotsDb = ReturnType<typeof getDb>;

export type InsertOutcome = "inserted" | "duplicate" | "limit";

/** The project's pivots in display order. */
export async function listPivots(projectId: string, db: PivotsDb): Promise<Pivot[]> {
  return db
    .select({
      key: projectPivots.key,
      label: projectPivots.label,
      presetId: projectPivots.presetId,
      position: projectPivots.position,
    })
    .from(projectPivots)
    .where(eq(projectPivots.projectId, projectId))
    .orderBy(asc(projectPivots.position), asc(projectPivots.key));
}

/**
 * Insert one pivot. The statement itself keeps the limit and the unique key,
 * so two adds at the same time cannot make a sixth pivot or a duplicate.
 */
export async function insertPivot(
  projectId: string,
  pivot: Pivot,
  db: PivotsDb,
): Promise<InsertOutcome> {
  const result = await db.execute<{ id: string }>(sql`
    insert into project_pivots (project_id, key, label, preset_id, position)
    select ${projectId}::uuid, ${pivot.key}, ${pivot.label}, ${pivot.presetId}, ${pivot.position}
    where (select count(*) from project_pivots where project_id = ${projectId}::uuid) < ${PIVOT_LIMIT}
    on conflict (project_id, key) do nothing
    returning id
  `);
  if (result.rows.length > 0) return "inserted";
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(projectPivots)
    .where(eq(projectPivots.projectId, projectId));
  return count >= PIVOT_LIMIT ? "limit" : "duplicate";
}

/** Rename one pivot. False when the project has no pivot with that key. */
export async function updatePivotLabel(
  projectId: string,
  key: string,
  label: string,
  db: PivotsDb,
): Promise<boolean> {
  const rows = await db
    .update(projectPivots)
    .set({ label, updatedAt: sql`now()` })
    .where(and(eq(projectPivots.projectId, projectId), eq(projectPivots.key, key)))
    .returning({ key: projectPivots.key });
  return rows.length > 0;
}

/** Remove one pivot and renumber the others from 0. False when there was none. */
export async function deletePivot(projectId: string, key: string, db: PivotsDb): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .delete(projectPivots)
      .where(and(eq(projectPivots.projectId, projectId), eq(projectPivots.key, key)))
      .returning({ key: projectPivots.key });
    if (rows.length === 0) return false;
    await renumber(projectId, tx);
    return true;
  });
}

/**
 * Put the pivots in the given key order (positions 0..n-1). False, and no
 * change, when `keys` is not exactly the project's pivot keys.
 */
export async function setPivotOrder(
  projectId: string,
  keys: readonly string[],
  db: PivotsDb,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const current = await tx
      .select({ key: projectPivots.key })
      .from(projectPivots)
      .where(eq(projectPivots.projectId, projectId))
      .for("update");
    const known = new Set(current.map((row) => row.key));
    if (
      keys.length !== known.size ||
      new Set(keys).size !== keys.length ||
      !keys.every((key) => known.has(key))
    ) {
      return false;
    }
    for (const [position, key] of keys.entries()) {
      await tx
        .update(projectPivots)
        .set({ position, updatedAt: sql`now()` })
        .where(and(eq(projectPivots.projectId, projectId), eq(projectPivots.key, key)));
    }
    return true;
  });
}

async function renumber(projectId: string, db: Pick<PivotsDb, "execute">): Promise<void> {
  await db.execute(sql`
    update project_pivots p set position = ordered.position
    from (
      select id, (row_number() over (order by position, key) - 1)::int as position
      from project_pivots where project_id = ${projectId}::uuid
    ) ordered
    where p.id = ordered.id and p.position <> ordered.position
  `);
}
