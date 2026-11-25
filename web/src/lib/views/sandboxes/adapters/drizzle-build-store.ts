import { and, eq, lt, sql } from "drizzle-orm";
import { SANDBOX_IMAGE_BUILD_JOB } from "@/lib/jobs/kinds";
import type { getDb } from "@/lib/platform/db/client";
import type { BuildStore } from "../ports/build-store";
import { sandboxes, sandboxVersions } from "../schema";
import { toVersion } from "./drizzle-version-store";

type Db = Pick<ReturnType<typeof getDb>, "select" | "update" | "execute">;

export function createDrizzleBuildStore(db: Db): BuildStore {
  const building = (versionId: string) =>
    and(eq(sandboxVersions.id, versionId), eq(sandboxVersions.status, "building"));
  const uploaded = (projectId: string, versionId: string) =>
    and(
      eq(sandboxVersions.id, versionId),
      eq(sandboxVersions.projectId, projectId),
      eq(sandboxVersions.status, "uploaded"),
    );
  return {
    async claim(projectId, versionId, now) {
      const [row] = await db
        .update(sandboxVersions)
        .set({ status: "building", reason: null, buildStartedAt: now, buildHeartbeatAt: now })
        .where(uploaded(projectId, versionId))
        .returning();
      if (!row) return null;
      const [sandbox] = await db
        .select({ name: sandboxes.name })
        .from(sandboxes)
        .where(eq(sandboxes.id, row.sandboxId));
      return toVersion(row, sandbox?.name ?? "");
    },

    async heartbeat(versionId, now) {
      await db.update(sandboxVersions).set({ buildHeartbeatAt: now }).where(building(versionId));
    },

    async finish(versionId, outcome, now) {
      await db
        .update(sandboxVersions)
        .set({
          status: outcome.status,
          buildLog: outcome.log,
          buildFinishedAt: now,
          ...(outcome.status === "ready"
            ? { imageRef: outcome.imageRef, reason: null }
            : { reason: outcome.reason }),
        })
        .where(building(versionId));
    },

    async leaveUnbuilt(projectId, versionId, reason) {
      await db.update(sandboxVersions).set({ reason }).where(uploaded(projectId, versionId));
    },

    async liveJobIds(since) {
      const result = await db.execute<{ id: string }>(sql`
        select j.id from jobs j
        where j.status = 'running' and j.kind = ${SANDBOX_IMAGE_BUILD_JOB}
          and exists (
            select 1 from sandbox_versions v
            where v.id::text = j.payload->>'versionId' and v.status = 'building'
              and v.build_heartbeat_at > ${since.toISOString()}
          )`);
      return result.rows.map((row) => row.id);
    },

    async failStopped(since, reason, now) {
      const rows = await db
        .update(sandboxVersions)
        .set({ status: "failed", reason, buildFinishedAt: now })
        .where(
          and(eq(sandboxVersions.status, "building"), lt(sandboxVersions.buildHeartbeatAt, since)),
        )
        .returning({ id: sandboxVersions.id });
      return rows.length;
    },

    async listUnqueued(before) {
      const result = await db.execute<{ project_id: string; id: string }>(sql`
        select v.project_id, v.id from sandbox_versions v
        where v.status = 'uploaded' and v.reason is null and v.created_at < ${before.toISOString()}
          and not exists (
            select 1 from jobs j
            where j.project_id = v.project_id and j.kind = ${SANDBOX_IMAGE_BUILD_JOB}
              and j.status in ('queued', 'running') and j.payload->>'versionId' = v.id::text
          )
        order by v.created_at limit 100`);
      return result.rows.map((row) => ({ projectId: row.project_id, versionId: row.id }));
    },
  };
}
