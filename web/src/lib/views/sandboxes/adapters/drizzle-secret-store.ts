import { and, asc, desc, eq, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import type { getDb } from "@/lib/platform/db/client";
import { secretNamesOf } from "../domain/config";
import type { SecretStore } from "../ports/secret-store";
import { sandboxes, sandboxSecrets, sandboxVersions } from "../schema";

type Db = Pick<ReturnType<typeof getDb>, "select" | "insert" | "delete">;

export function createDrizzleSecretStore(db: Db): SecretStore {
  return {
    list(projectId, sandboxName = null) {
      return db
        .select({ name: sandboxSecrets.name, updatedAt: sandboxSecrets.updatedAt })
        .from(sandboxSecrets)
        .where(and(eq(sandboxSecrets.projectId, projectId), atLevel(sandboxName)))
        .orderBy(asc(sandboxSecrets.name));
    },

    async set(projectId, name, sealedValue, updatedBy, sandboxName = null) {
      const change = { sealedValue, updatedBy, updatedAt: new Date() };
      // Each level has its own partial unique index, so the conflict names the index of the level.
      const conflict =
        sandboxName === null
          ? {
              target: [sandboxSecrets.projectId, sandboxSecrets.name],
              targetWhere: sql`${sandboxSecrets.sandboxName} is null`,
            }
          : {
              target: [sandboxSecrets.projectId, sandboxSecrets.sandboxName, sandboxSecrets.name],
              targetWhere: sql`${sandboxSecrets.sandboxName} is not null`,
            };
      await db
        .insert(sandboxSecrets)
        .values({ projectId, sandboxName, name, ...change })
        .onConflictDoUpdate({ ...conflict, set: change });
    },

    async remove(projectId, name, sandboxName = null) {
      const rows = await db
        .delete(sandboxSecrets)
        .where(
          and(
            eq(sandboxSecrets.projectId, projectId),
            eq(sandboxSecrets.name, name),
            atLevel(sandboxName),
          ),
        )
        .returning({ name: sandboxSecrets.name });
      return rows.length > 0;
    },

    async readSealed(projectId, names, sandboxName = null) {
      if (names.length === 0) return [];
      const levels = sandboxName === null ? atLevel(null) : or(atLevel(null), atLevel(sandboxName));
      return db
        .select({
          name: sandboxSecrets.name,
          sandboxName: sandboxSecrets.sandboxName,
          sealedValue: sandboxSecrets.sealedValue,
        })
        .from(sandboxSecrets)
        .where(
          and(
            eq(sandboxSecrets.projectId, projectId),
            inArray(sandboxSecrets.name, [...names]),
            levels,
          ),
        );
    },
  };
}

function atLevel(sandboxName: string | null): SQL {
  return sandboxName === null
    ? isNull(sandboxSecrets.sandboxName)
    : eq(sandboxSecrets.sandboxName, sandboxName);
}

/** The secret names of the newest version of a sandbox, of any status. Null: no such sandbox. */
export function createDrizzleDeclaredSecrets(db: Pick<Db, "select">) {
  return async (projectId: string, sandboxName: string): Promise<string[] | null> => {
    const [sandbox] = await db
      .select({ id: sandboxes.id })
      .from(sandboxes)
      .where(and(eq(sandboxes.projectId, projectId), eq(sandboxes.name, sandboxName)))
      .limit(1);
    if (!sandbox) return null;
    const [newest] = await db
      .select({ config: sandboxVersions.config })
      .from(sandboxVersions)
      .where(eq(sandboxVersions.sandboxId, sandbox.id))
      .orderBy(desc(sandboxVersions.createdAt))
      .limit(1);
    return newest ? secretNamesOf(newest.config) : [];
  };
}
