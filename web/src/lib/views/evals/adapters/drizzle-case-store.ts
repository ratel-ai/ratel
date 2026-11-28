import { isDeepStrictEqual } from "node:util";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { getDb } from "@/lib/platform/db/client";
import { storable } from "@/lib/platform/storable";
import type { CaseContent, CaseVersion, EvalCase } from "../domain/case";
import type { CaseStore, NewCase } from "../ports/case-store";
import {
  evalCases,
  evalCaseVersions,
  evalDatasets,
  evalDefinitions,
  evalDefinitionVersions,
} from "../schema";

type Db = Pick<ReturnType<typeof getDb>, "select" | "transaction">;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type CaseRow = typeof evalCases.$inferSelect;
type VersionRow = typeof evalCaseVersions.$inferSelect;

/** A rollback with no row added: one eval of the batch is not in the project. */
class EvalNotFound extends Error {}
/** A rollback with no row added: the dataset of one eval is a query, which holds no row. */
class NotFixed extends Error {}

export function createDrizzleCaseStore(db: Db): CaseStore {
  const createAll: CaseStore["createAll"] = async (inputs) => {
    try {
      return await db.transaction(async (tx) => {
        const made: EvalCase[] = [];
        for (const input of inputs) {
          const one = await insertCase(tx, input);
          if (!one) throw new EvalNotFound();
          made.push(one);
        }
        return made;
      });
    } catch (error) {
      if (error instanceof EvalNotFound) return "eval_not_found";
      if (error instanceof NotFixed) return "dataset_not_fixed";
      throw error;
    }
  };
  return {
    async create(input) {
      const made = await createAll([input]);
      return typeof made === "string" ? made : (made[0] ?? "eval_not_found");
    },

    createAll,

    async get(projectId, caseId) {
      const [row] = await db
        .select()
        .from(evalCases)
        .where(and(eq(evalCases.projectId, projectId), eq(evalCases.id, caseId)));
      if (!row) return null;
      const versions = await db
        .select()
        .from(evalCaseVersions)
        .where(eq(evalCaseVersions.caseId, caseId))
        .orderBy(desc(evalCaseVersions.number));
      return toCase(row, versions);
    },

    async list(projectId, evalId) {
      const ofEval =
        evalId === undefined
          ? undefined
          : inArray(evalCases.datasetId, datasetOfEval(db, projectId, evalId));
      const rows = await db
        .select()
        .from(evalCases)
        .where(
          and(
            eq(evalCases.projectId, projectId),
            isNull(evalCases.resolvedTurnId),
            eq(evalCases.runOnly, false),
            isNull(evalCases.removedAt),
            ofEval,
          ),
        )
        .orderBy(desc(evalCases.createdAt), desc(evalCases.id));
      if (rows.length === 0) return [];
      const versions = await db
        .select()
        .from(evalCaseVersions)
        .where(
          inArray(
            evalCaseVersions.caseId,
            rows.map(({ id }) => id),
          ),
        )
        .orderBy(desc(evalCaseVersions.number));
      const byCase = Map.groupBy(versions, ({ caseId }) => caseId);
      return rows.map((row) => toCase(row, byCase.get(row.id) ?? []));
    },

    update(projectId, caseId, { name, labels, content }, base, now) {
      return db.transaction(async (tx) => {
        // The row lock: two edits at the same time add one version.
        const [found] = await tx
          .select({ id: evalCases.id })
          .from(evalCases)
          .where(
            and(
              eq(evalCases.projectId, projectId),
              eq(evalCases.id, caseId),
              // A removed row is not edited: it is not a row of its dataset any more.
              isNull(evalCases.removedAt),
            ),
          )
          .for("update");
        if (!found) return "not_found";
        const [newest] = await tx
          .select()
          .from(evalCaseVersions)
          .where(eq(evalCaseVersions.caseId, caseId))
          .orderBy(desc(evalCaseVersions.number))
          .limit(1);
        if (!newest) throw new Error("the case has no version");
        if (newest.id !== base.versionId) return "changed";
        const [row] = await tx
          .update(evalCases)
          .set(storable({ name, labels }))
          .where(eq(evalCases.id, caseId))
          .returning();
        if (!row) throw new Error("the case row is missing");
        if (!isDeepStrictEqual(caseColumns(content), caseColumns(toVersion(newest)))) {
          await tx.insert(evalCaseVersions).values({
            ...caseColumns(content),
            caseId,
            number: newest.number + 1,
            sourceTurnId: newest.sourceTurnId,
            sourceOutput: newest.sourceOutput,
            createdAt: now,
            updatedAt: now,
          });
        }
        const versions = await tx
          .select()
          .from(evalCaseVersions)
          .where(eq(evalCaseVersions.caseId, caseId))
          .orderBy(desc(evalCaseVersions.number));
        return toCase(row, versions);
      });
    },
  };
}

/** Adds one case with its first version. Null when the project has no such eval. */
async function insertCase(
  tx: Tx,
  { projectId, evalId, name, labels, content, createdBy, source }: NewCase,
): Promise<EvalCase | null> {
  const now = new Date();
  // The lock keeps the eval while the case joins its dataset.
  const [owner] = await tx
    .select({ id: evalDefinitions.id })
    .from(evalDefinitions)
    .where(and(eq(evalDefinitions.projectId, projectId), eq(evalDefinitions.id, evalId)))
    .for("share");
  if (!owner) return null;
  const [dataset] = await tx
    .select({ id: evalDatasets.id, kind: evalDatasets.kind })
    .from(evalDatasets)
    .where(inArray(evalDatasets.id, datasetOfEval(tx, projectId, evalId)));
  if (!dataset) return null;
  if (dataset.kind !== "fixed") throw new NotFixed();
  const [row] = await tx
    .insert(evalCases)
    .values({
      ...storable({ name, labels }),
      projectId,
      datasetId: dataset.id,
      evalId,
      createdBy,
    })
    .returning();
  if (!row) throw new Error("the case row is missing");
  const [version] = await tx
    .insert(evalCaseVersions)
    .values({
      ...caseColumns(content),
      caseId: row.id,
      number: 1,
      sourceTurnId: source?.turnId ?? null,
      sourceOutput: storable(source?.output ?? null),
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!version) throw new Error("the version row is missing");
  return toCase(row, [version]);
}

/** The dataset of the newest version of an eval of the project, as a subquery. */
function datasetOfEval(db: Pick<Db, "select">, projectId: string, evalId: string) {
  return db
    .select({ id: evalDefinitionVersions.datasetId })
    .from(evalDefinitionVersions)
    .innerJoin(evalDefinitions, eq(evalDefinitions.id, evalDefinitionVersions.evalId))
    .where(and(eq(evalDefinitions.projectId, projectId), eq(evalDefinitionVersions.evalId, evalId)))
    .orderBy(desc(evalDefinitionVersions.number))
    .limit(1);
}

export function caseColumns({ input, earlierTurns, toolFixtures, expectedOutput }: CaseContent) {
  return storable({
    input: { value: input ?? null },
    earlierTurns,
    toolFixtures,
    expectedOutput,
  });
}

export function toCase(row: CaseRow, versions: VersionRow[]): EvalCase {
  const { id, projectId, datasetId, evalId, name, labels, createdAt } = row;
  return {
    id,
    projectId,
    datasetId,
    evalId,
    name,
    labels,
    createdAt,
    versions: versions.map(toVersion),
  };
}

export function toVersion(row: VersionRow): CaseVersion {
  const { createdAt: _, input, ...rest } = row;
  return { ...rest, input: input.value ?? null };
}
