import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { sandboxCommands, sandboxRunners, sandboxRuns } from "@/lib/views/sandboxes/schema";
import { gatewayChannel, runChannel, runNotifyPayload } from "../domain/channels";
import type { SandboxCommandKind } from "../domain/command";
import { LIVE_RUN_STATUSES } from "../domain/run";
import type { SandboxGatewayStore } from "../ports/gateway-store";
import { createPgSandboxRunStore, type SandboxDb } from "./pg-store";

/** The Postgres adapter of the gateway store. */
export function createPgSandboxGatewayStore(db: SandboxDb): SandboxGatewayStore {
  const runs = createPgSandboxRunStore(db);
  return {
    appendEvents: runs.appendEvents,
    markLost: runs.markLost,

    async registerRunner(input) {
      return db.transaction(async (tx) => {
        const providers = Array.isArray(input.manifest.providers) ? input.manifest.providers : [];
        const fields = {
          gatewayId: input.gatewayId,
          connectionId: input.connectionId,
          manifest: input.manifest,
          providers,
          build: (input.manifest.build as Record<string, unknown> | undefined) ?? null,
          maxConcurrency: input.maxConcurrency,
          connectedAt: sql`now()`,
          lastSeenAt: sql`now()`,
          disconnectedAt: null,
        };
        const [runner] = await tx
          .insert(sandboxRunners)
          .values({
            projectId: input.projectId,
            ownerUserId: input.ownerUserId,
            instanceId: input.instanceId,
            ...fields,
          })
          .onConflictDoUpdate({
            target: [
              sandboxRunners.projectId,
              sandboxRunners.ownerUserId,
              sandboxRunners.instanceId,
            ],
            set: fields,
          })
          .returning({ id: sandboxRunners.id });
        const moved = await tx.execute(sql`
          update sandbox_commands c set gateway_id = ${input.gatewayId}
          from sandbox_runs r
          where c.run_id = r.id and r.runner_id = ${runner!.id} and c.acked_at is null and c.gateway_id <> ${input.gatewayId}
          returning c.id
        `);
        if (rowCount(moved) > 0) {
          await tx.execute(sql`select pg_notify(${gatewayChannel(input.gatewayId)}, '{}')`);
        }
        return { runnerId: runner!.id };
      });
    },

    async updateManifest(runnerId, manifest) {
      const providers = Array.isArray(manifest.providers) ? manifest.providers : [];
      await db
        .update(sandboxRunners)
        .set({
          manifest,
          providers,
          build: (manifest.build as Record<string, unknown> | undefined) ?? null,
          lastSeenAt: sql`now()`,
        })
        .where(eq(sandboxRunners.id, runnerId));
    },

    async disconnectRunner(runnerId, connectionId) {
      await db
        .update(sandboxRunners)
        .set({ gatewayId: null, connectionId: null, disconnectedAt: sql`now()` })
        .where(and(eq(sandboxRunners.id, runnerId), eq(sandboxRunners.connectionId, connectionId)));
    },

    async pendingCommands(gatewayId) {
      const rows = await db
        .select({
          id: sandboxCommands.id,
          runId: sandboxCommands.runId,
          kind: sandboxCommands.kind,
          payload: sandboxCommands.payload,
          runnerId: sandboxRuns.runnerId,
          runStatus: sandboxRuns.status,
        })
        .from(sandboxCommands)
        .innerJoin(sandboxRuns, eq(sandboxRuns.id, sandboxCommands.runId))
        .where(and(eq(sandboxCommands.gatewayId, gatewayId), isNull(sandboxCommands.ackedAt)))
        .orderBy(asc(sandboxCommands.createdAt), asc(sandboxCommands.id));
      return rows.map((r) => ({
        ...r,
        kind: r.kind as SandboxCommandKind,
        payload: r.payload as Record<string, unknown>,
      }));
    },

    async ackCommand(commandId) {
      await db
        .update(sandboxCommands)
        .set({ ackedAt: sql`now()` })
        .where(and(eq(sandboxCommands.id, commandId), isNull(sandboxCommands.ackedAt)));
    },

    async runOwner(runId) {
      const [row] = await db
        .select({
          projectId: sandboxRuns.projectId,
          ownerUserId: sandboxRuns.ownerUserId,
          runnerId: sandboxRuns.runnerId,
          status: sandboxRuns.status,
        })
        .from(sandboxRuns)
        .where(eq(sandboxRuns.id, runId));
      return row ?? null;
    },

    async markRunAcked(runId, now) {
      await db
        .update(sandboxRuns)
        .set({
          status: "running",
          startedAt: sql`coalesce(${sandboxRuns.startedAt}, ${now})`,
          leaseAt: now,
        })
        .where(and(eq(sandboxRuns.id, runId), inArray(sandboxRuns.status, [...LIVE_RUN_STATUSES])));
    },

    async rejectRun(runId, reason, message, now) {
      await db
        .update(sandboxRuns)
        .set({
          status: "rejected",
          endedAt: now,
          error: { code: reason, message: message ?? `The runner refused the run: ${reason}.` },
        })
        .where(and(eq(sandboxRuns.id, runId), inArray(sandboxRuns.status, [...LIVE_RUN_STATUSES])));
      // Readers of the run wake up and read its new status.
      await db.execute(sql`select pg_notify(${runChannel(runId)}, ${runNotifyPayload(0)})`);
    },

    async failRun(runId, error, now) {
      await db
        .update(sandboxRuns)
        .set({ status: "error", endedAt: now, error })
        .where(and(eq(sandboxRuns.id, runId), inArray(sandboxRuns.status, [...LIVE_RUN_STATUSES])));
      await db.execute(sql`select pg_notify(${runChannel(runId)}, ${runNotifyPayload(0)})`);
    },

    async recordLease(runId, now) {
      await db
        .update(sandboxRuns)
        .set({ leaseAt: now })
        .where(and(eq(sandboxRuns.id, runId), inArray(sandboxRuns.status, [...LIVE_RUN_STATUSES])));
    },
  };
}

function rowCount(result: unknown): number {
  if (Array.isArray(result)) return result.length;
  const r = result as { rows?: unknown[]; rowCount?: number | null };
  return r.rows?.length ?? r.rowCount ?? 0;
}
