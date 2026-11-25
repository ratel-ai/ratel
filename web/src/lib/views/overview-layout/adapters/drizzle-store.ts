import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { LayoutKey, OverviewLayoutStore } from "../ports/store";
import { overviewLayouts } from "../schema";

type LayoutDb = Pick<NodePgDatabase, "select" | "insert" | "execute">;
type LayoutWriteDb = LayoutDb & {
  transaction<T>(run: (tx: LayoutDb) => Promise<T>): Promise<T>;
};

export function createDrizzleOverviewLayoutStore(db: LayoutWriteDb): OverviewLayoutStore {
  return {
    read: (key) => read(db, key),
    update: (key, next) =>
      db.transaction(async (tx) => {
        // The first change has no row to lock.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`overview_layouts:${key.projectId}:${key.personId}`}))`,
        );
        const stored = { layout: next(await read(tx, key)), updatedAt: new Date() };
        await tx
          .insert(overviewLayouts)
          .values({ ...key, ...stored })
          .onConflictDoUpdate({
            target: [overviewLayouts.projectId, overviewLayouts.personId],
            set: stored,
          });
      }),
  };
}

async function read(db: LayoutDb, { projectId, personId }: LayoutKey): Promise<unknown> {
  const [row] = await db
    .select({ layout: overviewLayouts.layout })
    .from(overviewLayouts)
    .where(and(eq(overviewLayouts.projectId, projectId), eq(overviewLayouts.personId, personId)));
  return row?.layout;
}
