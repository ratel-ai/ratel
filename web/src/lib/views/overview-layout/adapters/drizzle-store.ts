import { and, desc, eq, lte, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { KEPT_CHANGES, type LayoutRecord, NO_RECORD } from "../domain/history";
import type { LayoutKey, OverviewLayoutStore } from "../ports/store";
import { overviewLayoutChanges, overviewLayouts } from "../schema";

type LayoutDb = Pick<NodePgDatabase, "select" | "insert" | "delete" | "execute">;
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
        const write = next(await read(tx, key));
        if (write) {
          const { layout, source, ...entry } = write;
          const at = new Date();
          const stored = { layout, updatedAt: at };
          await tx
            .insert(overviewLayouts)
            .values({ ...key, ...stored })
            .onConflictDoUpdate({
              target: [overviewLayouts.projectId, overviewLayouts.personId],
              set: stored,
            });
          await tx.insert(overviewLayoutChanges).values({
            ...key,
            ...entry,
            layout,
            source: source.kind,
            client: source.kind === "mcp" ? source.client : null,
            createdAt: at,
          });
          await tx
            .delete(overviewLayoutChanges)
            .where(
              and(
                eq(overviewLayoutChanges.projectId, key.projectId),
                eq(overviewLayoutChanges.personId, key.personId),
                lte(overviewLayoutChanges.seq, entry.seq - KEPT_CHANGES),
              ),
            );
        }
        return read(tx, key);
      }),
  };
}

/** One statement, so that the layout and the entries are of one moment. */
async function read(db: LayoutDb, { projectId, personId }: LayoutKey): Promise<LayoutRecord> {
  const rows = await db
    .select({ layout: overviewLayouts.layout, entry: overviewLayoutChanges })
    .from(overviewLayouts)
    .leftJoin(
      overviewLayoutChanges,
      and(
        eq(overviewLayoutChanges.projectId, overviewLayouts.projectId),
        eq(overviewLayoutChanges.personId, overviewLayouts.personId),
      ),
    )
    .where(and(eq(overviewLayouts.projectId, projectId), eq(overviewLayouts.personId, personId)))
    .orderBy(desc(overviewLayoutChanges.seq))
    .limit(KEPT_CHANGES);
  if (rows.length === 0) return NO_RECORD;
  return {
    layout: rows[0].layout,
    entries: rows.flatMap(({ entry }) =>
      entry
        ? [
            {
              seq: entry.seq,
              kind: entry.kind,
              source:
                entry.source === "mcp"
                  ? { kind: "mcp" as const, client: entry.client }
                  : { kind: "web" as const },
              at: entry.createdAt,
              summary: entry.summary,
              undoes: entry.undoes,
              before: entry.before,
              layout: entry.layout,
            },
          ]
        : [],
    ),
  };
}
