import { isDeepStrictEqual } from "node:util";
import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";
import type { getDb } from "@/lib/platform/db/client";
import { isUniqueViolation } from "@/lib/platform/db/errors";
import { storable } from "@/lib/platform/storable";
import type { EvalCase } from "../domain/case";
import {
  type Dataset,
  type DatasetQuery,
  datasetQuerySchema,
  valuesContent,
} from "../domain/dataset";
import type { DatasetStore, NewRow } from "../ports/dataset-store";
import { evalCases, evalCaseVersions, evalDatasets } from "../schema";
import { caseColumns, toCase, toVersion } from "./drizzle-case-store";

type Db = Pick<ReturnType<typeof getDb>, "select" | "transaction">;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DatasetRow = typeof evalDatasets.$inferSelect;

/** The rows of one insert of versions: Postgres has a limit of 65,535 values. */
const CHUNK = 500;

export function createDrizzleDatasetStore(db: Db): DatasetStore {
  const read = async (where: ReturnType<typeof and>): Promise<Dataset | null> => {
    const [row] = await db.select().from(evalDatasets).where(where);
    return row ? toDataset(row) : null;
  };

  return {
    async create({ projectId, name, description, query, createdBy }) {
      try {
        return await db.transaction(async (tx) => {
          const [row] = await tx
            .insert(evalDatasets)
            .values({
              ...storable({ name, description }),
              ...queryColumns(query),
              projectId,
              createdBy,
            })
            .returning();
          if (!row) throw new Error("the dataset row is missing");
          return toDataset(row);
        });
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
        .orderBy(desc(evalDatasets.updatedAt), desc(evalDatasets.id));
      if (rows.length === 0) return [];
      const counts = await db
        .select({ datasetId: evalCases.datasetId, rows: count() })
        .from(evalCases)
        .where(
          and(
            inArray(
              evalCases.datasetId,
              rows.map(({ id }) => id),
            ),
            isNull(evalCases.resolvedTurnId),
            eq(evalCases.runOnly, false),
            isNull(evalCases.removedAt),
          ),
        )
        .groupBy(evalCases.datasetId);
      const byDataset = new Map(counts.map(({ datasetId, rows: n }) => [datasetId, n]));
      return rows.map((row) => ({ ...toDataset(row), rowCount: byDataset.get(row.id) ?? 0 }));
    },

    addRows(projectId, datasetId, rows, createdBy) {
      return db.transaction(async (tx) => {
        // The lock keeps the dataset while the rows join it.
        const [dataset] = await tx
          .select({ kind: evalDatasets.kind })
          .from(evalDatasets)
          .where(and(eq(evalDatasets.projectId, projectId), eq(evalDatasets.id, datasetId)))
          .for("update");
        if (!dataset) return "not_found";
        if (dataset.kind !== "fixed") return "not_fixed";
        const now = new Date();
        const made: EvalCase[] = [];
        for (const row of rows) {
          made.push(await insertRow(tx, { projectId, datasetId, createdBy, now }, row));
        }
        await tx.update(evalDatasets).set({ updatedAt: now }).where(eq(evalDatasets.id, datasetId));
        return made;
      });
    },

    addRunRows(projectId, datasetId, rows, createdBy) {
      return db.transaction(async (tx) => {
        const [dataset] = await tx
          .select({ id: evalDatasets.id })
          .from(evalDatasets)
          .where(and(eq(evalDatasets.projectId, projectId), eq(evalDatasets.id, datasetId)))
          .for("share");
        if (!dataset) return "not_found";
        const now = new Date();
        const made: EvalCase[] = [];
        for (const row of rows) {
          made.push(
            await insertRow(tx, { projectId, datasetId, createdBy, now, runOnly: true }, row),
          );
        }
        return made;
      });
    },

    removeRow(projectId, datasetId, rowId) {
      return db.transaction(async (tx) => {
        const [dataset] = await tx
          .select({ kind: evalDatasets.kind })
          .from(evalDatasets)
          .where(and(eq(evalDatasets.projectId, projectId), eq(evalDatasets.id, datasetId)))
          .for("update");
        if (!dataset) return "not_found";
        if (dataset.kind !== "fixed") return "not_fixed";
        const now = new Date();
        const removed = await tx
          .update(evalCases)
          .set({ removedAt: now })
          .where(
            and(
              eq(evalCases.datasetId, datasetId),
              eq(evalCases.id, rowId),
              isNull(evalCases.resolvedTurnId),
              eq(evalCases.runOnly, false),
              isNull(evalCases.removedAt),
            ),
          )
          .returning({ id: evalCases.id });
        if (removed.length === 0) return "not_found";
        await tx.update(evalDatasets).set({ updatedAt: now }).where(eq(evalDatasets.id, datasetId));
        return "removed";
      });
    },

    async rows(projectId, datasetId) {
      const rows = await db
        .select()
        .from(evalCases)
        .where(
          and(
            eq(evalCases.projectId, projectId),
            eq(evalCases.datasetId, datasetId),
            isNull(evalCases.resolvedTurnId),
            eq(evalCases.runOnly, false),
            isNull(evalCases.removedAt),
          ),
        )
        .orderBy(desc(evalCases.createdAt), desc(evalCases.id));
      return withVersions(db, rows);
    },

    keepResolved(projectId, datasetId, resolved, createdBy) {
      if (resolved.length === 0) return Promise.resolve([]);
      return db.transaction(async (tx) => {
        // One run at a time adds the rows of a dataset, so a turn gets one row.
        const [dataset] = await tx
          .select({ id: evalDatasets.id })
          .from(evalDatasets)
          .where(and(eq(evalDatasets.projectId, projectId), eq(evalDatasets.id, datasetId)))
          .for("update");
        if (!dataset) throw new Error("the dataset is missing");
        const turnIds = resolved.map(({ turnId }) => turnId);
        const rows = await tx
          .select()
          .from(evalCases)
          .where(
            and(eq(evalCases.datasetId, datasetId), inArray(evalCases.resolvedTurnId, turnIds)),
          );
        const cases = await withVersions(tx, rows);
        const byTurn = new Map(rows.map((row, index) => [row.resolvedTurnId, cases[index]]));
        const now = new Date();
        const kept: EvalCase[] = [];
        for (const { turnId, content, sourceOutput } of resolved) {
          const found = byTurn.get(turnId);
          const newest = found?.versions[0];
          if (found && newest && isDeepStrictEqual(caseColumns(content), caseColumns(newest))) {
            kept.push(found);
            continue;
          }
          if (found && newest) {
            const [version] = await tx
              .insert(evalCaseVersions)
              .values({
                ...caseColumns(content),
                caseId: found.id,
                number: newest.number + 1,
                sourceTurnId: turnId,
                sourceOutput: storable(sourceOutput),
                createdAt: now,
                updatedAt: now,
              })
              .returning();
            if (!version) throw new Error("the version row is missing");
            kept.push({ ...found, versions: [toVersion(version), ...found.versions] });
            continue;
          }
          kept.push(
            await insertRow(
              tx,
              { projectId, datasetId, createdBy, now, resolvedTurnId: turnId },
              { kind: "trace", name: rowName(turnId), turnId, content, sourceOutput },
            ),
          );
        }
        return kept;
      });
    },
  };
}

/** Adds one row with its first version. */
async function insertRow(
  tx: Tx,
  at: {
    projectId: string;
    datasetId: string;
    createdBy: string;
    now: Date;
    resolvedTurnId?: string;
    runOnly?: boolean;
  },
  row: NewRow,
): Promise<EvalCase> {
  const { projectId, datasetId, createdBy, now, resolvedTurnId, runOnly } = at;
  const content = row.kind === "values" ? valuesContent(row.row) : row.content;
  const [made] = await tx
    .insert(evalCases)
    .values({
      ...storable({ name: row.name, labels: [...new Set(row.labels ?? [])] }),
      projectId,
      datasetId,
      evalId: null,
      resolvedTurnId: resolvedTurnId ?? null,
      runOnly: runOnly ?? false,
      createdBy,
      createdAt: now,
    })
    .returning();
  if (!made) throw new Error("the case row is missing");
  const [version] = await tx
    .insert(evalCaseVersions)
    .values({
      ...caseColumns(content),
      caseId: made.id,
      number: 1,
      sourceTurnId: row.kind === "trace" ? row.turnId : null,
      sourceOutput: storable(row.kind === "trace" ? row.sourceOutput : null),
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!version) throw new Error("the version row is missing");
  return toCase(made, [version]);
}

/** The cases with their versions, the newest first, in the order of the rows. */
async function withVersions(
  db: Pick<Db, "select">,
  rows: Array<typeof evalCases.$inferSelect>,
): Promise<EvalCase[]> {
  if (rows.length === 0) return [];
  const versions: Array<typeof evalCaseVersions.$inferSelect> = [];
  const ids = rows.map(({ id }) => id);
  for (let start = 0; start < ids.length; start += CHUNK) {
    versions.push(
      ...(await db
        .select()
        .from(evalCaseVersions)
        .where(inArray(evalCaseVersions.caseId, ids.slice(start, start + CHUNK)))
        .orderBy(desc(evalCaseVersions.number))),
    );
  }
  const byCase = Map.groupBy(versions, ({ caseId }) => caseId);
  return rows.map((row) => toCase(row, byCase.get(row.id) ?? []));
}

/** Neutral: a name reaches readers that may not read captured text. */
function rowName(turnId: string): string {
  return `Turn ${turnId.slice(0, 8)}`;
}

function queryColumns(query: DatasetQuery) {
  const { kind, ...settings } = query;
  return { kind, settings: storable(settings) };
}

function toDataset(row: DatasetRow): Dataset {
  const { id, projectId, name, description, kind, settings, createdBy, createdAt, updatedAt } = row;
  const query = datasetQuerySchema.parse({ ...settings, kind });
  return { id, projectId, name, description, query, createdBy, createdAt, updatedAt };
}
