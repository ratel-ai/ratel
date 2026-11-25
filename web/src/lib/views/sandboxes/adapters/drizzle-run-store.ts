import { and, asc, desc, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import type { getDb } from "@/lib/platform/db/client";
import type { RunStatus, SandboxRun } from "../domain/run";
import type { RunStore } from "../ports/run-store";
import { sandboxInstances, sandboxRuns } from "../schema";

type Db = Pick<ReturnType<typeof getDb>, "select" | "update" | "transaction">;

const ACTIVE = ["queued", "running"];

export function createDrizzleRunStore(db: Db): RunStore {
  return {
    create(run, check) {
      return db.transaction(async (tx) => {
        // One start of a project at a time, so the counts below are right.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`sandbox_runs:${run.projectId}`}, 0))`,
        );
        const [present] = await tx
          .select({
            instances: sql<number>`count(*) filter (where ${hasInstance()})::int`,
            today: sql<number>`count(*) filter (where ${sandboxRuns.createdAt} >= date_trunc('day', now(), 'UTC'))::int`,
          })
          .from(sandboxRuns)
          .where(
            and(
              eq(sandboxRuns.projectId, run.projectId),
              sql`(${sandboxRuns.createdAt} >= date_trunc('day', now(), 'UTC') or ${hasInstance()})`,
            ),
          );
        const checked = await check(present ?? { instances: 0, today: 0 });
        if (!checked.ok) return checked;
        const [row] = await tx.insert(sandboxRuns).values(run).returning();
        if (!row) throw new Error("the run row is missing");
        return { ok: true as const, run: toRun(row) };
      });
    },

    async get(projectId, runId) {
      const [row] = await db
        .select()
        .from(sandboxRuns)
        .where(and(eq(sandboxRuns.projectId, projectId), eq(sandboxRuns.id, runId)));
      return row ? toRun(row) : null;
    },

    async list(projectId, limit) {
      const rows = await db
        .select()
        .from(sandboxRuns)
        .where(eq(sandboxRuns.projectId, projectId))
        .orderBy(desc(sandboxRuns.createdAt))
        .limit(limit);
      return rows.map(toRun);
    },

    async findByTokenHash(tokenHash) {
      const [row] = await db
        .select({ id: sandboxRuns.id, projectId: sandboxRuns.projectId })
        .from(sandboxRuns)
        .where(and(eq(sandboxRuns.tokenHash, tokenHash), inArray(sandboxRuns.status, ACTIVE)));
      return row ?? null;
    },

    markStarted({ id, projectId }, instanceRef, now) {
      return db.transaction(async (tx) => {
        await tx
          .insert(sandboxInstances)
          .values({ runId: id, projectId, instanceRef, startedAt: now });
        const [row] = await tx
          .update(sandboxRuns)
          .set({
            instanceRef,
            startedAt: now,
            // The result can come first: an ended run keeps its status.
            status: sql`case when ${sandboxRuns.status} = 'queued' then 'running' else ${sandboxRuns.status} end`,
          })
          .where(eq(sandboxRuns.id, id))
          .returning({ status: sandboxRuns.status });
        return row ? (row.status as RunStatus) : null;
      });
    },

    async finish(runId, outcome, now) {
      const rows = await db
        .update(sandboxRuns)
        .set({
          status: outcome.status,
          finishedAt: now,
          ...("result" in outcome
            ? { result: outcome.result, traceId: outcome.result.traceId }
            : { reason: outcome.reason }),
        })
        .where(and(eq(sandboxRuns.id, runId), inArray(sandboxRuns.status, ACTIVE)))
        .returning({ id: sandboxRuns.id });
      return rows.length > 0;
    },

    async markInstanceStopped(runId, now) {
      await db.transaction(async (tx) => {
        await tx
          .update(sandboxRuns)
          .set({ instanceStoppedAt: now })
          .where(eq(sandboxRuns.id, runId));
        await tx.delete(sandboxInstances).where(eq(sandboxInstances.runId, runId));
      });
    },

    async markUsageRecorded(runId, now) {
      await db.update(sandboxRuns).set({ usageRecordedAt: now }).where(eq(sandboxRuns.id, runId));
    },

    async listOpen(limit) {
      const columns = {
        id: sandboxRuns.id,
        projectId: sandboxRuns.projectId,
        status: sandboxRuns.status,
        instanceRef: sandboxRuns.instanceRef,
        instanceStoppedAt: sandboxRuns.instanceStoppedAt,
        usageRecordedAt: sandboxRuns.usageRecordedAt,
        timeoutS: sandboxRuns.timeoutS,
        createdAt: sandboxRuns.createdAt,
        startedAt: sandboxRuns.startedAt,
      };
      // The two conditions of sandbox_runs_open_idx, each with its own limit: the active runs of
      // all projects must not hide the ended ones, and the other way round.
      const open = (condition: SQL) =>
        db
          .select(columns)
          .from(sandboxRuns)
          .where(condition)
          .orderBy(asc(sandboxRuns.createdAt))
          .limit(limit);
      const [ended, active] = await Promise.all([
        open(
          sql`${sandboxRuns.status} not in ('queued', 'running') and ${sandboxRuns.instanceRef} is not null and (${sandboxRuns.instanceStoppedAt} is null or ${sandboxRuns.usageRecordedAt} is null)`,
        ),
        open(sql`${sandboxRuns.status} in ('queued', 'running')`),
      ]);
      return [...ended, ...active].map((row) => ({ ...row, status: row.status as RunStatus }));
    },

    async listOrphans(limit) {
      return db
        .select({
          id: sandboxInstances.runId,
          projectId: sandboxInstances.projectId,
          instanceRef: sandboxInstances.instanceRef,
        })
        .from(sandboxInstances)
        .leftJoin(sandboxRuns, eq(sandboxRuns.id, sandboxInstances.runId))
        .where(isNull(sandboxRuns.id))
        .orderBy(asc(sandboxInstances.startedAt))
        .limit(limit);
    },
  };
}

/** A run that has, or is about to have, an instance. */
function hasInstance() {
  return sql`(${sandboxRuns.status} in ('queued', 'running') or (${sandboxRuns.instanceRef} is not null and ${sandboxRuns.instanceStoppedAt} is null))`;
}

function toRun(row: typeof sandboxRuns.$inferSelect): SandboxRun {
  const { tokenHash: _tokenHash, usageRecordedAt: _usage, ...run } = row;
  return { ...run, status: run.status as RunStatus };
}
