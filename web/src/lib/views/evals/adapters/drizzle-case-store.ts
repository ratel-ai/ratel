import { isDeepStrictEqual } from "node:util";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { getDb } from "@/lib/platform/db/client";
import { storable } from "@/lib/platform/storable";
import type { CaseContent, CaseVersion, EvalCase } from "../domain/case";
import type { CaseRefusal, CaseStore, NewCase } from "../ports/case-store";
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

/** A rollback with no row added: one eval or dataset of the batch is not in the project, or not fixed. */
class Refused extends Error {
  constructor(readonly reason: CaseRefusal) {
    super(reason);
  }
}

export function createDrizzleCaseStore(db: Db): CaseStore {
  const createAll: CaseStore["createAll"] = async (inputs) => {
    try {
      return await db.transaction(async (tx) => {
        const made: EvalCase[] = [];
        for (const input of inputs) {
          const one = await insertCase(tx, input, made);
          if (typeof one === "string") throw new Refused(one);
          made.push(one);
        }
        return made;
      });
    } catch (error) {
      if (error instanceof Refused) return error.reason;
      throw error;
    }
  };
  const listWhere = async (where: ReturnType<typeof and>) => {
    const rows = await db
      .select()
      .from(evalCases)
      .where(where)
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
      if (evalId === undefined) return listWhere(eq(evalCases.projectId, projectId));
      const datasetId = await datasetOfEval(db, projectId, evalId);
      return datasetId === null
        ? []
        : listWhere(and(eq(evalCases.projectId, projectId), eq(evalCases.datasetId, datasetId)));
    },

    listDataset(projectId, datasetId) {
      return listWhere(and(eq(evalCases.projectId, projectId), eq(evalCases.datasetId, datasetId)));
    },

    update(projectId, caseId, { name, labels, content }, base, now) {
      return db.transaction(async (tx) => {
        // The row lock: two edits at the same time add one version.
        const [found] = await tx
          .select({ id: evalCases.id })
          .from(evalCases)
          .where(and(eq(evalCases.projectId, projectId), eq(evalCases.id, caseId)))
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
        if (!isDeepStrictEqual(columns(content), columns(toVersion(newest)))) {
          await tx.insert(evalCaseVersions).values({
            ...columns(content),
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

/**
 * The dataset of the newest version of an eval of the project. Null when the project has no such
 * eval.
 */
export async function datasetOfEval(
  db: Pick<Db, "select">,
  projectId: string,
  evalId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ datasetId: evalDefinitionVersions.datasetId })
    .from(evalDefinitionVersions)
    .innerJoin(evalDefinitions, eq(evalDefinitions.id, evalDefinitionVersions.evalId))
    .where(and(eq(evalDefinitions.projectId, projectId), eq(evalDefinitions.id, evalId)))
    .orderBy(desc(evalDefinitionVersions.number))
    .limit(1);
  return row?.datasetId ?? null;
}

/** Adds one case with its first version, to the dataset (or to the dataset of the eval). */
async function insertCase(
  tx: Tx,
  { projectId, evalId, datasetId: given, name, labels, content, createdBy, source }: NewCase,
  batch: readonly EvalCase[],
): Promise<EvalCase | CaseRefusal> {
  const now = new Date();
  const datasetId =
    given ?? (evalId === undefined ? null : await datasetOfEval(tx, projectId, evalId));
  if (!datasetId) return "eval_not_found";
  // Two evals of one batch can share the dataset: the same row for each goes into it one time.
  const same =
    evalId === undefined
      ? undefined
      : batch.find(
          (one) =>
            one.datasetId === datasetId &&
            one.name === name &&
            isDeepStrictEqual(columns(content), columns(one.versions[0] ?? content)),
        );
  if (same) return same;
  // The lock keeps the dataset while the case joins it.
  const [owner] = await tx
    .select({ id: evalDatasets.id, kind: evalDatasets.kind })
    .from(evalDatasets)
    .where(and(eq(evalDatasets.projectId, projectId), eq(evalDatasets.id, datasetId)))
    .for("share");
  if (!owner) return "eval_not_found";
  if (owner.kind !== "fixed") return "not_fixed";
  const [row] = await tx
    .insert(evalCases)
    .values({
      ...storable({ name, labels }),
      projectId,
      datasetId,
      evalId: evalId ?? null,
      createdBy,
    })
    .returning();
  if (!row) throw new Error("the case row is missing");
  const [version] = await tx
    .insert(evalCaseVersions)
    .values({
      ...columns(content),
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

function columns({ input, earlierTurns, toolFixtures, expectedOutput }: CaseContent) {
  return storable({
    input: { value: input ?? null },
    earlierTurns,
    toolFixtures,
    expectedOutput,
  });
}

function toCase(row: CaseRow, versions: VersionRow[]): EvalCase {
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
