import { desc, eq, sql } from "drizzle-orm";
import type { getDb } from "@/lib/platform/db/client";
import type { SandboxIndex } from "../ports/sandbox-index";
import { sandboxes, sandboxRuns, sandboxVersions } from "../schema";
import { toVersion } from "./drizzle-version-store";

type Db = Pick<ReturnType<typeof getDb>, "select" | "selectDistinctOn">;

export function createDrizzleSandboxIndex(db: Db): SandboxIndex {
  return {
    async list(projectId) {
      const [newest, counts, lastRuns] = await Promise.all([
        db
          .selectDistinctOn([sandboxVersions.sandboxId], {
            version: sandboxVersions,
            name: sandboxes.name,
          })
          .from(sandboxVersions)
          .innerJoin(sandboxes, eq(sandboxes.id, sandboxVersions.sandboxId))
          .where(eq(sandboxVersions.projectId, projectId))
          .orderBy(sandboxVersions.sandboxId, desc(sandboxVersions.createdAt)),
        db
          .select({ sandboxId: sandboxVersions.sandboxId, count: sql<number>`count(*)::int` })
          .from(sandboxVersions)
          .where(eq(sandboxVersions.projectId, projectId))
          .groupBy(sandboxVersions.sandboxId),
        db
          .select({
            sandboxId: sandboxVersions.sandboxId,
            at: sql<Date>`max(${sandboxRuns.createdAt})`.mapWith(sandboxRuns.createdAt),
          })
          .from(sandboxRuns)
          .innerJoin(sandboxVersions, eq(sandboxVersions.id, sandboxRuns.versionId))
          .where(eq(sandboxRuns.projectId, projectId))
          .groupBy(sandboxVersions.sandboxId),
      ]);
      const countOf = new Map(counts.map((row) => [row.sandboxId, row.count]));
      const lastRunOf = new Map(lastRuns.map((row) => [row.sandboxId, row.at]));
      return newest
        .map(({ version, name }) => ({
          name,
          newest: toVersion(version, name),
          versions: countOf.get(version.sandboxId) ?? 1,
          lastRunAt: lastRunOf.get(version.sandboxId) ?? null,
        }))
        .sort((a, b) => b.newest.createdAt.getTime() - a.newest.createdAt.getTime());
    },
  };
}
