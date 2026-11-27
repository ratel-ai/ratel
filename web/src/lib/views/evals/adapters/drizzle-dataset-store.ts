import { and, asc, count, eq, like, max, or } from "drizzle-orm";
import type { getDb } from "@/lib/platform/db/client";
import { isUniqueViolation } from "@/lib/platform/db/errors";
import { storable } from "@/lib/platform/storable";
import { columnsOf, type Dataset, definitionOf, MAX_DATASET_NAME_CHARS } from "../domain/dataset";
import type { DatasetStore } from "../ports/dataset-store";
import { evalCases, evalDatasets } from "../schema";

type Db = Pick<ReturnType<typeof getDb>, "select" | "insert">;
type Row = typeof evalDatasets.$inferSelect;

export function createDrizzleDatasetStore(db: Db): DatasetStore {
  const read = async (where: ReturnType<typeof and>) => {
    const [row] = await db.select().from(evalDatasets).where(where);
    return row ? toDataset(row) : null;
  };
  return {
    async create({ projectId, name, definition, createdBy }) {
      try {
        const [row] = await db
          .insert(evalDatasets)
          .values({ ...storable({ name, ...columnsOf(definition) }), projectId, createdBy })
          .returning();
        if (!row) throw new Error("the dataset row is missing");
        return toDataset(row);
      } catch (error) {
        if (isUniqueViolation(error)) return "name_taken";
        throw error;
      }
    },

    get(projectId, datasetId) {
      return read(and(eq(evalDatasets.projectId, projectId), eq(evalDatasets.id, datasetId)));
    },

    getByName(projectId, name) {
      return read(and(eq(evalDatasets.projectId, projectId), eq(evalDatasets.name, name)));
    },

    async list(projectId) {
      const rows = await db
        .select()
        .from(evalDatasets)
        .where(eq(evalDatasets.projectId, projectId))
        .orderBy(asc(evalDatasets.createdAt), asc(evalDatasets.id));
      return rows.map(toDataset);
    },

    async rowStats(projectId) {
      const rows = await db
        .select({ datasetId: evalCases.datasetId, rows: count(), lastAddedAt: max(evalCases.createdAt) })
        .from(evalCases)
        .where(eq(evalCases.projectId, projectId))
        .groupBy(evalCases.datasetId);
      return new Map(
        rows.map(({ datasetId, rows: n, lastAddedAt }) => [datasetId, { rows: n, lastAddedAt }]),
      );
    },
  };
}

/**
 * The first free name of a new fixed dataset of an eval: the name of the eval, else with ` (2)`,
 * ` (3)`... In the transaction of the eval.
 */
export async function freeDatasetName(
  db: Pick<Db, "select">,
  projectId: string,
  wanted: string,
): Promise<string> {
  const base = wanted.slice(0, MAX_DATASET_NAME_CHARS - 6);
  const taken = new Set(
    (
      await db
        .select({ name: evalDatasets.name })
        .from(evalDatasets)
        .where(
          and(
            eq(evalDatasets.projectId, projectId),
            or(eq(evalDatasets.name, wanted), like(evalDatasets.name, `${escapeLike(base)} (%)`)),
          ),
        )
    ).map(({ name }) => name),
  );
  if (!taken.has(wanted)) return wanted;
  for (let n = 2; ; n += 1) {
    const name = `${base} (${n})`;
    if (!taken.has(name)) return name;
  }
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export function toDataset(row: Row): Dataset {
  const { id, projectId, name, kind, settings, createdBy, createdAt, updatedAt } = row;
  return {
    id,
    projectId,
    name,
    definition: definitionOf(kind, settings),
    createdBy,
    createdAt,
    updatedAt,
  };
}
