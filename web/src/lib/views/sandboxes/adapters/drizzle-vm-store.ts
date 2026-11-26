import { and, asc, desc, eq, gt, inArray, lt, ne, or, sql } from "drizzle-orm";
import type { getDb } from "@/lib/platform/db/client";
import type { RunVm, VmStore } from "../ports/vm-store";
import { sandboxRuns, sandboxVms } from "../schema";

type Db = Pick<ReturnType<typeof getDb>, "select" | "update" | "transaction">;

export function createDrizzleVmStore(db: Db): VmStore {
  return {
    claim(claim, check) {
      return db.transaction(async (tx) => {
        // One claim of a project at a time, so the counts below are right.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`sandbox_vms:${claim.projectId}`}, 0))`,
        );
        const active = sql<number>`(select count(*) from ${sandboxRuns} where ${sandboxRuns.vmId} = ${sandboxVms.id} and ${sandboxRuns.status} in ('queued', 'running'))`;
        const [warm] = await tx
          .select()
          .from(sandboxVms)
          .where(
            and(
              eq(sandboxVms.versionId, claim.versionId),
              eq(sandboxVms.state, "ready"),
              gt(sandboxVms.startedAt, claim.startedAfter),
              lt(active, claim.maxRuns),
            ),
          )
          // The VM used last is the warmest.
          .orderBy(desc(sandboxVms.lastUsedAt))
          .limit(1);
        if (warm) {
          await assign(tx, claim.runId, warm.id);
          return { ok: true as const, vm: toVm(warm), isNew: false };
        }
        const [today] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(sandboxVms)
          .where(
            and(
              eq(sandboxVms.projectId, claim.projectId),
              sql`${sandboxVms.startedAt} >= date_trunc('day', now(), 'UTC')`,
            ),
          );
        const checked = await check(today?.count ?? 0);
        if (!checked.ok) return checked;
        const [row] = await tx
          .insert(sandboxVms)
          .values({
            projectId: claim.projectId,
            versionId: claim.versionId,
            startedAt: claim.now,
            lastUsedAt: claim.now,
          })
          .returning();
        if (!row) throw new Error("the vm row is missing");
        await assign(tx, claim.runId, row.id);
        return { ok: true as const, vm: toVm(row), isNew: true };
      });
    },

    async markReady(vmId, vmRef, now) {
      await db
        .update(sandboxVms)
        .set({ vmRef, state: "ready", lastUsedAt: now })
        .where(and(eq(sandboxVms.id, vmId), eq(sandboxVms.state, "starting")));
    },

    async touch(vmId, now) {
      await db
        .update(sandboxVms)
        .set({ lastUsedAt: now })
        .where(and(eq(sandboxVms.id, vmId), lt(sandboxVms.lastUsedAt, now)));
    },

    async markDeleted(vmId, now) {
      await db
        .update(sandboxVms)
        .set({ state: "deleted", deletedAt: now })
        .where(and(eq(sandboxVms.id, vmId), ne(sandboxVms.state, "deleted")));
    },

    async get(vmId) {
      const [row] = await db.select().from(sandboxVms).where(eq(sandboxVms.id, vmId));
      return row ? toVm(row) : null;
    },

    async listIdle(idleSince, startingSince, limit) {
      const noActiveRun = sql`not exists (select 1 from ${sandboxRuns} where ${sandboxRuns.vmId} = ${sandboxVms.id} and ${sandboxRuns.status} in ('queued', 'running'))`;
      const rows = await db
        .select()
        .from(sandboxVms)
        .where(
          or(
            and(eq(sandboxVms.state, "ready"), lt(sandboxVms.lastUsedAt, idleSince), noActiveRun),
            and(eq(sandboxVms.state, "starting"), lt(sandboxVms.startedAt, startingSince)),
          ),
        )
        .orderBy(asc(sandboxVms.lastUsedAt))
        .limit(limit);
      return rows.map(toVm);
    },

    async live(vmIds) {
      if (vmIds.length === 0) return new Set();
      const rows = await db
        .select({ id: sandboxVms.id })
        .from(sandboxVms)
        .where(and(inArray(sandboxVms.id, [...vmIds]), ne(sandboxVms.state, "deleted")));
      return new Set(rows.map(({ id }) => id));
    },
  };
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function assign(tx: Tx, runId: string, vmId: string) {
  await tx.update(sandboxRuns).set({ vmId }).where(eq(sandboxRuns.id, runId));
}

function toVm(row: typeof sandboxVms.$inferSelect): RunVm {
  return {
    id: row.id,
    projectId: row.projectId,
    versionId: row.versionId,
    vmRef: row.vmRef,
    state: row.state as RunVm["state"],
    startedAt: row.startedAt,
    lastUsedAt: row.lastUsedAt,
  };
}
