import { and, asc, desc, eq, gt, inArray, lt, lte, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as schema from "@/lib/platform/db/tables";
import {
  type SandboxRunRow,
  sandboxCommands,
  sandboxRunEvents,
  sandboxRunners,
  sandboxRuns,
  sandboxSessions,
} from "@/lib/views/sandboxes/schema";
import {
  gatewayChannel,
  gatewayNotifyPayload,
  runChannel,
  runNotifyPayload,
} from "../domain/channels";
import {
  confirmDecisionPayload,
  runCancelPayload,
  runStartPayload,
  type SandboxCommandKind,
} from "../domain/command";
import {
  eventRetentionCutoff,
  isTerminalStatus,
  LIVE_RUN_STATUSES,
  leaseCutoff,
  normalizeEventBatch,
  refuseStart,
  runEndFields,
} from "../domain/run";
import type { SandboxRunStore, SandboxRunView } from "../ports/store";

/**
 * Any Drizzle Postgres database over the app schema: node-postgres in the web
 * app and the gateway, PGlite in tests. The gateway passes its own pool, so
 * this module never imports `@/lib/db` (and its env-driven pool).
 */
export type SandboxDb = PgDatabase<PgQueryResultHKT, typeof schema>;
type Tx = Parameters<Parameters<SandboxDb["transaction"]>[0]>[0];

const DEFAULT_READ_LIMIT = 1_000;
const DEFAULT_LIST_LIMIT = 50;

/** The Postgres adapter of the sandbox run store. */
export function createPgSandboxRunStore(db: SandboxDb): SandboxRunStore {
  return {
    async startRun(request) {
      return db.transaction(async (tx) => {
        const [runner] = await tx
          .select()
          .from(sandboxRunners)
          .where(eq(sandboxRunners.id, request.runnerId));
        const refusal = refuseStart(runner ?? null, request);
        if (refusal) return { ok: false, reason: refusal };
        const gatewayId = runner!.gatewayId!;

        const sessionId = await resolveSession(tx, request);
        if (!sessionId) return { ok: false, reason: "session_not_owner" };

        const [run] = await tx
          .insert(sandboxRuns)
          .values({
            projectId: request.projectId,
            sandboxId: request.sandboxId,
            sessionId,
            ownerUserId: request.ownerUserId,
            runnerId: runner!.id,
            configHash: request.configHash,
            input: request.input ?? null,
            params: request.params,
            toolModes: request.toolModes,
            context: request.context,
            overrides: request.overrides,
          })
          .returning({ id: sandboxRuns.id });
        await sendCommand(tx, gatewayId, run!.id, "run.start", runStartPayload(request, sessionId));
        return { ok: true, runId: run!.id, sessionId, gatewayId };
      });
    },

    async cancelRun({ runId, projectId, ownerUserId, reason }) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select({ status: sandboxRuns.status, gatewayId: sandboxRunners.gatewayId })
          .from(sandboxRuns)
          .leftJoin(sandboxRunners, eq(sandboxRunners.id, sandboxRuns.runnerId))
          .where(
            and(
              eq(sandboxRuns.id, runId),
              eq(sandboxRuns.projectId, projectId),
              eq(sandboxRuns.ownerUserId, ownerUserId),
            ),
          )
          .for("update", { of: sandboxRuns });
        if (!row) return { ok: false, reason: "run_not_found" };
        if (isTerminalStatus(row.status)) return { ok: false, reason: "run_not_live" };
        if (!row.gatewayId) {
          // Nobody can end it: the runner is gone. The run ends here.
          await tx
            .update(sandboxRuns)
            .set({ status: "canceled", endedAt: sql`now()` })
            .where(eq(sandboxRuns.id, runId));
          await notifyRun(tx, runId, 0);
          return { ok: true, status: "canceled" };
        }
        await sendCommand(tx, row.gatewayId, runId, "run.cancel", runCancelPayload(reason));
        return { ok: true, status: row.status as "queued" | "running" };
      });
    },

    async decideConfirm({ runId, projectId, ownerUserId, callId, decision, args, result }) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select({ status: sandboxRuns.status, gatewayId: sandboxRunners.gatewayId })
          .from(sandboxRuns)
          .leftJoin(sandboxRunners, eq(sandboxRunners.id, sandboxRuns.runnerId))
          .where(
            and(
              eq(sandboxRuns.id, runId),
              eq(sandboxRuns.projectId, projectId),
              eq(sandboxRuns.ownerUserId, ownerUserId),
            ),
          )
          .for("update", { of: sandboxRuns });
        if (!row) return { ok: false, reason: "run_not_found" };
        if (isTerminalStatus(row.status)) return { ok: false, reason: "run_not_live" };
        const pending = await tx.execute(sql`
          select c.payload->>'tool' as tool
          from sandbox_run_events c
          where c.run_id = ${runId} and c.kind = 'tool.call' and c.payload->>'callId' = ${callId} and c.payload->>'mode' = 'confirm'
            and not exists (
              select 1 from sandbox_run_events r where r.run_id = ${runId} and r.kind = 'tool.result' and r.payload->>'callId' = ${callId}
            )
            and not exists (
              select 1 from sandbox_commands d where d.run_id = ${runId} and d.kind = 'tool.confirm.decision' and d.payload->>'callId' = ${callId}
            )
          limit 1
        `);
        const tool = rowsOf<{ tool: string }>(pending)[0]?.tool;
        if (!tool) return { ok: false, reason: "call_not_pending" };
        if (!row.gatewayId) return { ok: false, reason: "runner_offline" };
        await sendCommand(
          tx,
          row.gatewayId,
          runId,
          "tool.confirm.decision",
          confirmDecisionPayload({ callId, decision, args, result }),
        );
        return { ok: true, tool };
      });
    },

    async appendEvents(runId, events) {
      const batch = normalizeEventBatch(events);
      return db.transaction(async (tx) => {
        if (batch.length > 0) {
          await tx
            .insert(sandboxRunEvents)
            .values(batch.map((e) => ({ runId, seq: e.seq, kind: e.kind, payload: e.payload })))
            .onConflictDoNothing({ target: [sandboxRunEvents.runId, sandboxRunEvents.seq] });
        }
        const ackedSeq = await advanceAckedSeq(tx, runId);
        // The end counts only inside the contiguous prefix: a run.end stored
        // past a gap is applied by the append that repairs the gap.
        const [end] = await tx
          .select({ payload: sandboxRunEvents.payload })
          .from(sandboxRunEvents)
          .where(
            and(
              eq(sandboxRunEvents.runId, runId),
              eq(sandboxRunEvents.kind, "run.end"),
              lte(sandboxRunEvents.seq, ackedSeq),
            ),
          )
          .limit(1);
        if (end) await recordEnd(tx, runId, end.payload as Record<string, unknown>);
        await notifyRun(tx, runId, ackedSeq);
        return { ackedSeq };
      });
    },

    async readEventsAfter(runId, afterSeq, limit = DEFAULT_READ_LIMIT) {
      const rows = await db
        .select({
          seq: sandboxRunEvents.seq,
          kind: sandboxRunEvents.kind,
          payload: sandboxRunEvents.payload,
          createdAt: sandboxRunEvents.createdAt,
        })
        .from(sandboxRunEvents)
        .where(
          and(
            eq(sandboxRunEvents.runId, runId),
            gt(sandboxRunEvents.seq, afterSeq),
            // Only the contiguous prefix: the same acked_seq the worker gets in
            // events.ack. A row past a gap waits until the gap is repaired.
            lte(
              sandboxRunEvents.seq,
              sql`(select ${sandboxRuns.ackedSeq} from ${sandboxRuns} where ${sandboxRuns.id} = ${runId})`,
            ),
          ),
        )
        .orderBy(asc(sandboxRunEvents.seq))
        .limit(limit);
      return rows.map((r) => ({ ...r, payload: r.payload as Record<string, unknown> }));
    },

    async markLost(now, leaseTimeoutMs) {
      const cutoff = leaseCutoff(now, leaseTimeoutMs);
      return db.transaction(async (tx) => {
        const lost = await tx
          .update(sandboxRuns)
          .set({
            status: "lost",
            endedAt: now,
            error: { code: "lost", message: "The runner stopped sending a lease." },
          })
          .where(
            and(
              inArray(sandboxRuns.status, [...LIVE_RUN_STATUSES]),
              lt(
                sql`coalesce(${sandboxRuns.leaseAt}, ${sandboxRuns.startedAt}, ${sandboxRuns.createdAt})`,
                cutoff,
              ),
            ),
          )
          .returning({ id: sandboxRuns.id, ackedSeq: sandboxRuns.ackedSeq });
        for (const run of lost) await notifyRun(tx, run.id, run.ackedSeq);
        return lost.map((r) => r.id);
      });
    },

    async pruneExpiredEvents(now, retentionDays) {
      const cutoff = eventRetentionCutoff(now, retentionDays);
      const expiredRuns = db
        .select({ id: sandboxRuns.id })
        .from(sandboxRuns)
        .where(lt(sandboxRuns.endedAt, cutoff));
      const deleted = await db
        .delete(sandboxRunEvents)
        .where(inArray(sandboxRunEvents.runId, expiredRuns))
        .returning({ seq: sandboxRunEvents.seq });
      await db.delete(sandboxCommands).where(inArray(sandboxCommands.runId, expiredRuns));
      return deleted.length;
    },

    async listRunners(projectId) {
      const rows = await db
        .select()
        .from(sandboxRunners)
        .where(eq(sandboxRunners.projectId, projectId))
        .orderBy(desc(sandboxRunners.connectedAt));
      return rows.map((r) => ({
        id: r.id,
        ownerUserId: r.ownerUserId,
        instanceId: r.instanceId,
        online: r.gatewayId !== null,
        manifest: r.manifest as Record<string, unknown>,
        maxConcurrency: r.maxConcurrency,
        connectedAt: r.connectedAt,
        lastSeenAt: r.lastSeenAt,
      }));
    },

    async getRun(projectId, runId) {
      const [r] = await db
        .select()
        .from(sandboxRuns)
        .where(and(eq(sandboxRuns.id, runId), eq(sandboxRuns.projectId, projectId)));
      return r ? runView(r) : null;
    },

    async listRuns({ projectId, ownerUserId, sandboxId, limit = DEFAULT_LIST_LIMIT }) {
      // sandbox_runs_project_sandbox_idx (project_id, sandbox_id, created_at) serves the filter and the order.
      const rows = await db
        .select()
        .from(sandboxRuns)
        .where(
          and(
            eq(sandboxRuns.projectId, projectId),
            eq(sandboxRuns.sandboxId, sandboxId),
            eq(sandboxRuns.ownerUserId, ownerUserId),
          ),
        )
        .orderBy(desc(sandboxRuns.createdAt), desc(sandboxRuns.id))
        .limit(limit);
      return rows.map((r) => ({
        ...runView(r),
        input: r.input,
        params: (r.params ?? {}) as Record<string, unknown>,
        usage: r.usage,
      }));
    },
  };
}

function runView(r: SandboxRunRow): SandboxRunView {
  return {
    id: r.id,
    sandboxId: r.sandboxId,
    sessionId: r.sessionId,
    ownerUserId: r.ownerUserId,
    runnerId: r.runnerId,
    status: r.status,
    configHash: r.configHash,
    overrides: r.overrides,
    output: r.output,
    error: r.error,
    traceId: r.traceId,
    createdAt: r.createdAt,
    endedAt: r.endedAt,
  };
}

/** The session of the run: the requested one when it belongs to this owner and sandbox, else a new one. */
async function resolveSession(
  tx: Tx,
  request: Parameters<SandboxRunStore["startRun"]>[0],
): Promise<string | null> {
  if (request.sessionId) {
    const [session] = await tx
      .update(sandboxSessions)
      .set({ lastRunAt: sql`now()`, runnerId: request.runnerId })
      .where(
        and(
          eq(sandboxSessions.id, request.sessionId),
          eq(sandboxSessions.projectId, request.projectId),
          eq(sandboxSessions.ownerUserId, request.ownerUserId),
          eq(sandboxSessions.sandboxId, request.sandboxId),
        ),
      )
      .returning({ id: sandboxSessions.id });
    return session?.id ?? null;
  }
  const [session] = await tx
    .insert(sandboxSessions)
    .values({
      projectId: request.projectId,
      sandboxId: request.sandboxId,
      ownerUserId: request.ownerUserId,
      runnerId: request.runnerId,
      lastRunAt: sql`now()`,
    })
    .returning({ id: sandboxSessions.id });
  return session!.id;
}

async function sendCommand(
  tx: Tx,
  gatewayId: string,
  runId: string,
  kind: SandboxCommandKind,
  payload: Record<string, unknown>,
): Promise<void> {
  await tx.insert(sandboxCommands).values({ gatewayId, runId, kind, payload });
  await tx.execute(
    sql`select pg_notify(${gatewayChannel(gatewayId)}, ${gatewayNotifyPayload(runId)})`,
  );
}

/**
 * Moves the run's acked seq over the stored rows that follow it with no gap.
 * Rows after a gap stay stored but unacked, so the worker resends from the gap.
 */
async function advanceAckedSeq(tx: Tx, runId: string): Promise<number> {
  const result = await tx.execute(sql`
    with run as (
      select acked_seq from sandbox_runs where id = ${runId} for update
    ), stored as (
      select e.seq, run.acked_seq + row_number() over (order by e.seq) as expected
      from sandbox_run_events e, run
      where e.run_id = ${runId} and e.seq > run.acked_seq
    )
    update sandbox_runs
    set acked_seq = coalesce((select max(seq) from stored where seq = expected), sandbox_runs.acked_seq)
    where id = ${runId}
    returning acked_seq
  `);
  const row = rowsOf<{ acked_seq: number }>(result)[0];
  if (!row) throw new Error(`sandbox run not found: ${runId}`);
  return Number(row.acked_seq);
}

/** A `run.end` ends a live run, and also a lost one whose runner came back and finished it. */
async function recordEnd(tx: Tx, runId: string, payload: Record<string, unknown>): Promise<void> {
  const end = runEndFields(payload);
  await tx
    .update(sandboxRuns)
    .set({
      status: end.status,
      output: end.output,
      error: end.error,
      usage: end.usage,
      traceId: end.traceId,
      ...(end.overrides ? { overrides: end.overrides } : {}),
      endedAt: sql`now()`,
    })
    .where(
      and(eq(sandboxRuns.id, runId), inArray(sandboxRuns.status, [...LIVE_RUN_STATUSES, "lost"])),
    );
}

async function notifyRun(tx: Tx, runId: string, seq: number): Promise<void> {
  await tx.execute(sql`select pg_notify(${runChannel(runId)}, ${runNotifyPayload(seq)})`);
}

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}
