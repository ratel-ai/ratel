import { and, asc, eq, inArray } from "drizzle-orm";
import type { getDb } from "@/lib/platform/db/client";
import type { SecretStore } from "../ports/secret-store";
import { sandboxSecrets } from "../schema";

type Db = Pick<ReturnType<typeof getDb>, "select" | "insert" | "delete">;

export function createDrizzleSecretStore(db: Db): SecretStore {
  const one = (projectId: string, name: string) =>
    and(eq(sandboxSecrets.projectId, projectId), eq(sandboxSecrets.name, name));
  return {
    list(projectId) {
      return db
        .select({ name: sandboxSecrets.name, updatedAt: sandboxSecrets.updatedAt })
        .from(sandboxSecrets)
        .where(eq(sandboxSecrets.projectId, projectId))
        .orderBy(asc(sandboxSecrets.name));
    },

    async set(projectId, name, sealedValue, updatedBy) {
      const change = { sealedValue, updatedBy, updatedAt: new Date() };
      await db
        .insert(sandboxSecrets)
        .values({ projectId, name, ...change })
        .onConflictDoUpdate({
          target: [sandboxSecrets.projectId, sandboxSecrets.name],
          set: change,
        });
    },

    async remove(projectId, name) {
      const rows = await db
        .delete(sandboxSecrets)
        .where(one(projectId, name))
        .returning({ name: sandboxSecrets.name });
      return rows.length > 0;
    },

    async readSealed(projectId, names) {
      if (names.length === 0) return new Map();
      const rows = await db
        .select({ name: sandboxSecrets.name, sealedValue: sandboxSecrets.sealedValue })
        .from(sandboxSecrets)
        .where(
          and(eq(sandboxSecrets.projectId, projectId), inArray(sandboxSecrets.name, [...names])),
        );
      return new Map(rows.map((row) => [row.name, row.sealedValue]));
    },
  };
}
