import { and, asc, desc, eq, inArray, notLike, type SQL, sql } from "drizzle-orm";
import type { getDb } from "@/lib/platform/db/client";
import { EVAL_TRIAL_PREFIX, type RunStatus, resultOf, type SandboxRun } from "../domain/run";
import type { VersionStatus } from "../domain/version";
import type { RunStore } from "../ports/run-store";
import { sandboxRuns, sandboxVersions } from "../schema";

type Db = Pick<ReturnType<typeof getDb>, "select" | "update" | "delete" | "transaction">;

const ACTIVE = ["queued", "running"];

export function createDrizzleRunStore(db: Db): RunStore {
  return {
    create(run, check) {
      return db.transaction(async (tx) => {
        // One start of a project at a time, so the counts below are right.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`sandbox_runs:${run.projectId}`}, 0))`,
        );
        // A retire takes the same lock (`drizzle-retention-store.ts`): this read sees it.
        const [version] = await tx
          .select({ status: sandboxVersions.status })
          .from(sandboxVersions)
          .where(
            and(
              eq(sandboxVersions.id, run.versionId),
              eq(sandboxVersions.projectId, run.projectId),
            ),
          );
        if (version?.status !== "ready") {
          return {
            ok: false as const,
            versionStatus: (version?.status ?? null) as VersionStatus | null,
          };
        }
        const [present] = await tx
          .select({
            active: sql<number>`count(*) filter (where ${sandboxRuns.status} in ('queued', 'running'))::int`,
            today: sql<number>`count(*) filter (where ${sandboxRuns.createdAt} >= date_trunc('day', now(), 'UTC'))::int`,
          })
          .from(sandboxRuns)
          .where(
            and(
              eq(sandboxRuns.projectId, run.projectId),
              sql`(${sandboxRuns.createdAt} >= date_trunc('day', now(), 'UTC') or ${sandboxRuns.status} in ('queued', 'running'))`,
            ),
          );
        const checked = await check(present ?? { active: 0, today: 0 });
        if (!checked.ok) return checked;
        const { request, ...columns } = run;
        const [row] = await tx
          .insert(sandboxRuns)
          .values({ ...columns, runInput: request })
          .returning();
        if (!row) throw new Error("the run row is missing");
        return { ok: true as const, run: toRun(row) };
      });
    },

    async discard(runId) {
      await db
        .delete(sandboxRuns)
        .where(and(eq(sandboxRuns.id, runId), eq(sandboxRuns.status, "queued")));
    },

    async get(projectId, runId) {
      const [row] = await db
        .select()
        .from(sandboxRuns)
        .where(and(eq(sandboxRuns.projectId, projectId), eq(sandboxRuns.id, runId)));
      return row ? toRun(row) : null;
    },

    async list(projectId, limit, options = {}) {
      const rows = await db
        .select()
        .from(sandboxRuns)
        .where(
          and(
            eq(sandboxRuns.projectId, projectId),
            options.excludeEvalTrials
              ? notLike(sandboxRuns.requestedBy, `${EVAL_TRIAL_PREFIX}%`)
              : undefined,
          ),
        )
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

    async markStarted(runId, instanceRef, now) {
      const [started] = await db
        .update(sandboxRuns)
        .set({ instanceRef, startedAt: now, status: "running" })
        .where(and(eq(sandboxRuns.id, runId), eq(sandboxRuns.status, "queued")))
        .returning({ status: sandboxRuns.status });
      if (started) return "running";
      // The sweep can end a run first: an ended run keeps its status.
      const [row] = await db
        .select({ status: sandboxRuns.status })
        .from(sandboxRuns)
        .where(eq(sandboxRuns.id, runId));
      return row ? (row.status as RunStatus) : null;
    },

    async finish(runId, outcome, now) {
      const ended =
        outcome.status === "completed"
          ? {
              response: outcome.response,
              logs: outcome.logs,
              durationMs: outcome.durationMs,
            }
          : {
              errorCode: outcome.errorCode,
              reason: outcome.message,
              ...(outcome.logs === undefined ? {} : { logs: outcome.logs }),
              ...(outcome.durationMs === undefined ? {} : { durationMs: outcome.durationMs }),
            };
      const rows = await db
        .update(sandboxRuns)
        .set({ status: outcome.status, finishedAt: now, ...ended })
        .where(and(eq(sandboxRuns.id, runId), inArray(sandboxRuns.status, ACTIVE)))
        .returning({ id: sandboxRuns.id });
      return rows.length > 0;
    },

    async markUsageRecorded(runId, now) {
      await db.update(sandboxRuns).set({ usageRecordedAt: now }).where(eq(sandboxRuns.id, runId));
    },

    async listOpen(limit) {
      const columns = {
        id: sandboxRuns.id,
        projectId: sandboxRuns.projectId,
        status: sandboxRuns.status,
        vmId: sandboxRuns.vmId,
        instanceRef: sandboxRuns.instanceRef,
        usageRecordedAt: sandboxRuns.usageRecordedAt,
        timeoutS: sandboxRuns.timeoutS,
        createdAt: sandboxRuns.createdAt,
        startedAt: sandboxRuns.startedAt,
        finishedAt: sandboxRuns.finishedAt,
        durationMs: sandboxRuns.durationMs,
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
          sql`${sandboxRuns.status} not in ('queued', 'running') and ${sandboxRuns.startedAt} is not null and ${sandboxRuns.usageRecordedAt} is null`,
        ),
        open(sql`${sandboxRuns.status} in ('queued', 'running')`),
      ]);
      return [...ended, ...active].map((row) => ({ ...row, status: row.status as RunStatus }));
    },
  };
}

function toRun(row: typeof sandboxRuns.$inferSelect): SandboxRun {
  const { tokenHash: _token, usageRecordedAt: _usage, runInput, ...run } = row;
  const stored = { ...run, request: runInput, status: run.status as RunStatus };
  return { ...stored, result: resultOf(stored) };
}
