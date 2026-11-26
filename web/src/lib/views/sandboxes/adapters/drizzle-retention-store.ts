import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { getDb } from "@/lib/platform/db/client";
import type { RetentionStore } from "../ports/retention-store";
import { sandboxes, sandboxRuns, sandboxVersions, sandboxVms } from "../schema";

type Db = Pick<ReturnType<typeof getDb>, "select" | "selectDistinct" | "update" | "transaction">;

const ACTIVE = ["queued", "running"];

/** The versions that hold a snapshot: `sandbox_versions_snapshot_idx` covers them. */
const HAS_SNAPSHOT = isNotNull(sandboxVersions.imageRef);

export function createDrizzleRetentionStore(db: Db): RetentionStore {
  return {
    async listCrowded(keep, limit) {
      const crowded = db
        .select({ sandboxId: sandboxVersions.sandboxId })
        .from(sandboxVersions)
        .where(and(eq(sandboxVersions.status, "ready"), HAS_SNAPSHOT))
        .groupBy(sandboxVersions.sandboxId)
        .having(sql`count(*) > ${keep}`)
        .orderBy(sql`random()`)
        .limit(limit);
      const rows = await db
        .select({
          id: sandboxVersions.id,
          projectId: sandboxVersions.projectId,
          name: sandboxes.name,
          createdAt: sandboxVersions.createdAt,
          imageRef: sandboxVersions.imageRef,
        })
        .from(sandboxVersions)
        .innerJoin(sandboxes, eq(sandboxes.id, sandboxVersions.sandboxId))
        .where(
          and(
            eq(sandboxVersions.status, "ready"),
            HAS_SNAPSHOT,
            inArray(sandboxVersions.sandboxId, crowded),
          ),
        );
      return rows.flatMap((row) => (row.imageRef ? [{ ...row, imageRef: row.imageRef }] : []));
    },

    async inUse(versionIds) {
      if (versionIds.length === 0) return new Set();
      const ids = [...versionIds];
      const [running, live] = await Promise.all([
        db
          .selectDistinct({ id: sandboxRuns.versionId })
          .from(sandboxRuns)
          .where(and(inArray(sandboxRuns.versionId, ids), inArray(sandboxRuns.status, ACTIVE))),
        db
          .selectDistinct({ id: sandboxVms.versionId })
          .from(sandboxVms)
          .where(and(inArray(sandboxVms.versionId, ids), sql`${sandboxVms.state} <> 'deleted'`)),
      ]);
      return new Set([...running, ...live].map((row) => row.id));
    },

    retire(version, reason) {
      return db.transaction(async (tx) => {
        // The lock of a run start (`drizzle-run-store.ts`): a start waits for the retire, and the
        // retire waits for a start. The update below then sees the run of that start.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`sandbox_runs:${version.projectId}`}, 0))`,
        );
        const rows = await tx
          .update(sandboxVersions)
          .set({ status: "retired", reason })
          .where(
            and(
              eq(sandboxVersions.id, version.id),
              eq(sandboxVersions.projectId, version.projectId),
              eq(sandboxVersions.status, "ready"),
              sql`not exists (select 1 from ${sandboxRuns} where ${sandboxRuns.versionId} = ${version.id} and ${sandboxRuns.status} in ('queued', 'running'))`,
              sql`not exists (select 1 from ${sandboxVms} where ${sandboxVms.versionId} = ${version.id} and ${sandboxVms.state} <> 'deleted')`,
            ),
          )
          .returning({ id: sandboxVersions.id });
        return rows.length > 0;
      });
    },

    async listRetiredSnapshots(limit) {
      const rows = await db
        .select({
          id: sandboxVersions.id,
          projectId: sandboxVersions.projectId,
          imageRef: sandboxVersions.imageRef,
        })
        .from(sandboxVersions)
        .where(and(eq(sandboxVersions.status, "retired"), HAS_SNAPSHOT))
        .limit(limit);
      return rows.flatMap((row) => (row.imageRef ? [{ ...row, imageRef: row.imageRef }] : []));
    },

    async markSnapshotDeleted(versionId) {
      await db
        .update(sandboxVersions)
        .set({ imageRef: null })
        .where(and(eq(sandboxVersions.id, versionId), eq(sandboxVersions.status, "retired")));
    },

    async existing(versionIds) {
      if (versionIds.length === 0) return new Set();
      const rows = await db
        .select({ id: sandboxVersions.id })
        .from(sandboxVersions)
        .where(inArray(sandboxVersions.id, [...versionIds]));
      return new Set(rows.map((row) => row.id));
    },
  };
}
