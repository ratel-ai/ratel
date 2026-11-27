import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { getDb } from "@/lib/platform/db/client";
import type { SandboxVersion, VersionStatus } from "../domain/version";
import type { VersionStore } from "../ports/version-store";
import { sandboxes, sandboxVersions } from "../schema";

type Db = Pick<ReturnType<typeof getDb>, "select" | "update" | "transaction">;

export function createDrizzleVersionStore(db: Db): VersionStore {
  return {
    create(input, check) {
      return db.transaction(async (tx) => {
        // One push of a project at a time, so the count below is right.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`sandbox_versions:${input.projectId}`}, 0))`,
        );
        const [row] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(sandboxVersions)
          .where(
            and(
              eq(sandboxVersions.projectId, input.projectId),
              gte(sandboxVersions.createdAt, sql`date_trunc('day', now(), 'UTC')`),
            ),
          );
        const checked = await check(row?.count ?? 0);
        if (!checked.ok) return checked;

        const { name } = input.manifest;
        await tx
          .insert(sandboxes)
          .values({ projectId: input.projectId, name })
          .onConflictDoNothing();
        const [sandbox] = await tx
          .select({ id: sandboxes.id })
          .from(sandboxes)
          .where(and(eq(sandboxes.projectId, input.projectId), eq(sandboxes.name, name)));
        if (!sandbox) throw new Error("the sandbox row is missing");
        const [version] = await tx
          .insert(sandboxVersions)
          .values({
            projectId: input.projectId,
            sandboxId: sandbox.id,
            manifest: input.manifest,
            gitCommit: input.git.commit,
            gitDirty: input.git.dirty,
            bundleSha256: input.bundle.sha256,
            bundleBytes: input.bundle.bytes,
            apiKeyId: input.apiKeyId,
          })
          .returning();
        if (!version) throw new Error("the version row is missing");
        return { ok: true as const, version: toVersion(version, name) };
      });
    },

    async get(projectId, versionId) {
      const [row] = await db
        .select({ version: sandboxVersions, name: sandboxes.name })
        .from(sandboxVersions)
        .innerJoin(sandboxes, eq(sandboxes.id, sandboxVersions.sandboxId))
        .where(and(eq(sandboxVersions.projectId, projectId), eq(sandboxVersions.id, versionId)));
      return row ? toVersion(row.version, row.name) : null;
    },

    async list(projectId, limit) {
      const rows = await db
        .select({ version: sandboxVersions, name: sandboxes.name })
        .from(sandboxVersions)
        .innerJoin(sandboxes, eq(sandboxes.id, sandboxVersions.sandboxId))
        .where(eq(sandboxVersions.projectId, projectId))
        .orderBy(desc(sandboxVersions.createdAt))
        .limit(limit);
      return rows.map((row) => toVersion(row.version, row.name));
    },

    async markUploaded(projectId, versionId) {
      const rows = await db
        .update(sandboxVersions)
        .set({ status: "uploaded" })
        .where(
          and(
            eq(sandboxVersions.projectId, projectId),
            eq(sandboxVersions.id, versionId),
            eq(sandboxVersions.status, "uploading"),
          ),
        )
        .returning({ id: sandboxVersions.id });
      return rows.length > 0;
    },

    async markRefused(projectId, versionId, reason) {
      await db
        .update(sandboxVersions)
        .set({ status: "failed", reason })
        .where(
          and(
            eq(sandboxVersions.projectId, projectId),
            eq(sandboxVersions.id, versionId),
            eq(sandboxVersions.status, "uploading"),
          ),
        );
    },
  };
}

export function toVersion(row: typeof sandboxVersions.$inferSelect, name: string): SandboxVersion {
  return {
    id: row.id,
    projectId: row.projectId,
    sandboxId: row.sandboxId,
    name,
    manifest: row.manifest,
    git: { commit: row.gitCommit, dirty: row.gitDirty },
    bundle: { sha256: row.bundleSha256, bytes: row.bundleBytes },
    status: row.status as VersionStatus,
    reason: row.reason,
    imageRef: row.imageRef,
    buildLog: row.buildLog,
    createdAt: row.createdAt,
  };
}
