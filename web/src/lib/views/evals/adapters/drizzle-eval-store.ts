import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { getDb } from "@/lib/platform/db/client";
import { isUniqueViolation } from "@/lib/platform/db/errors";
import { storable } from "@/lib/platform/storable";
import {
  type EvalContent,
  type EvalDefinition,
  type EvalVersion,
  sameContent,
} from "../domain/eval";
import type { EvalStore } from "../ports/eval-store";
import { evalDefinitions, evalDefinitionVersions } from "../schema";

type Db = Pick<ReturnType<typeof getDb>, "select" | "transaction">;
type EvalRow = typeof evalDefinitions.$inferSelect;
type VersionRow = typeof evalDefinitionVersions.$inferSelect;

export function createDrizzleEvalStore(db: Db): EvalStore {
  const read = async (where: ReturnType<typeof and>): Promise<EvalDefinition | null> => {
    const [row] = await db.select().from(evalDefinitions).where(where);
    return row ? withVersions(db, row) : null;
  };

  return {
    async create({ projectId, name, taskId, content, createdBy }) {
      try {
        return await db.transaction(async (tx) => {
          const [row] = await tx
            .insert(evalDefinitions)
            .values({ ...storable({ name, taskId }), projectId, createdBy })
            .returning();
          if (!row) throw new Error("the eval row is missing");
          const [version] = await tx
            .insert(evalDefinitionVersions)
            .values({ ...columns(content), evalId: row.id, number: 1, createdBy })
            .returning();
          if (!version) throw new Error("the eval version row is missing");
          return toEval(row, [version]);
        });
      } catch (error) {
        if (isUniqueViolation(error)) return "name_taken";
        throw error;
      }
    },

    get(projectId, evalId) {
      return read(and(eq(evalDefinitions.projectId, projectId), eq(evalDefinitions.id, evalId)));
    },

    getByName(projectId, name) {
      return read(and(eq(evalDefinitions.projectId, projectId), eq(evalDefinitions.name, name)));
    },

    async list(projectId) {
      const rows = await db
        .select()
        .from(evalDefinitions)
        .where(eq(evalDefinitions.projectId, projectId))
        .orderBy(asc(evalDefinitions.createdAt), asc(evalDefinitions.id));
      if (rows.length === 0) return [];
      const versions = await db
        .select()
        .from(evalDefinitionVersions)
        .where(
          inArray(
            evalDefinitionVersions.evalId,
            rows.map(({ id }) => id),
          ),
        )
        .orderBy(desc(evalDefinitionVersions.number));
      const byEval = Map.groupBy(versions, ({ evalId }) => evalId);
      return rows.map((row) => toEval(row, byEval.get(row.id) ?? []));
    },

    async update(projectId, evalId, { name, taskId, content }, base, { userId, now }) {
      try {
        return await db.transaction(async (tx) => {
          // The row lock: two edits at the same time add one version.
          const [found] = await tx
            .select({ id: evalDefinitions.id })
            .from(evalDefinitions)
            .where(and(eq(evalDefinitions.projectId, projectId), eq(evalDefinitions.id, evalId)))
            .for("update");
          if (!found) return "not_found";
          const [newest] = await tx
            .select()
            .from(evalDefinitionVersions)
            .where(eq(evalDefinitionVersions.evalId, evalId))
            .orderBy(desc(evalDefinitionVersions.number))
            .limit(1);
          if (!newest) throw new Error("the eval has no version");
          if (newest.id !== base) return "changed";
          const [row] = await tx
            .update(evalDefinitions)
            .set(storable({ name, taskId }))
            .where(eq(evalDefinitions.id, evalId))
            .returning();
          if (!row) throw new Error("the eval row is missing");
          if (!sameContent(storable(content), toVersion(newest))) {
            await tx.insert(evalDefinitionVersions).values({
              ...columns(content),
              evalId,
              number: newest.number + 1,
              createdBy: userId,
              createdAt: now,
            });
          }
          return withVersions(tx, row);
        });
      } catch (error) {
        if (isUniqueViolation(error)) return "name_taken";
        throw error;
      }
    },

    async versions(versionIds) {
      if (versionIds.length === 0) return [];
      const rows = await db
        .select()
        .from(evalDefinitionVersions)
        .where(inArray(evalDefinitionVersions.id, [...versionIds]));
      return rows.map(toVersion);
    },
  };
}

async function withVersions(db: Pick<Db, "select">, row: EvalRow): Promise<EvalDefinition> {
  const versions = await db
    .select()
    .from(evalDefinitionVersions)
    .where(eq(evalDefinitionVersions.evalId, row.id))
    .orderBy(desc(evalDefinitionVersions.number));
  return toEval(row, versions);
}

function columns({ sandboxName, params, trials, scorers }: EvalContent) {
  return storable({ sandboxName, params, trials, scorers });
}

function toEval(row: EvalRow, versions: VersionRow[]): EvalDefinition {
  const { id, projectId, name, taskId, createdAt } = row;
  return { id, projectId, name, taskId, createdAt, versions: versions.map(toVersion) };
}

function toVersion(row: VersionRow): EvalVersion {
  const { id, evalId, number, sandboxName, params, trials, scorers, createdBy, createdAt } = row;
  return { id, evalId, number, sandboxName, params, trials, scorers, createdBy, createdAt };
}
