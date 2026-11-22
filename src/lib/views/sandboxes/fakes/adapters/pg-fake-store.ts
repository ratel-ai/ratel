import { and, desc, eq, sql } from "drizzle-orm";
import { projects } from "@/lib/platform/projects/schema";
import {
  sandboxCommands,
  sandboxFakePins,
  sandboxRuns,
  sandboxSessions,
} from "@/lib/views/sandboxes/schema";
import type { SandboxDb } from "../../adapters/pg-store";
import type { FakeLedger, RecordedCall } from "../domain/fake";
import type { FakeRunContext, FakeStore } from "../ports/fake-store";

/**
 * The Postgres adapter of the fake store, shared by the gateway (its own pool)
 * and tests (PGlite). Recorded calls come from the session's own tool events
 * (real calls, and confirm calls the reviewer approved as sent) and from the
 * replay source's `execute_tool` spans; production examples from the
 * project's `execute_tool` spans. No read returns a fake: event results with
 * mode fake and spans with `ratel.tool.mode=fake` are left out.
 */

/** Recorded calls read per request, newest first. */
const RECORDED_LIMIT = 200;
/** Production results read per request before the most similar are picked. */
const EXAMPLE_POOL = 50;
const EXAMPLE_WINDOW_DAYS = 30;

export function createPgFakeStore(db: SandboxDb): FakeStore {
  return {
    async runContext(runId) {
      if (!/^[0-9a-f-]{36}$/i.test(runId)) return null;
      const [row] = await db
        .select({
          projectId: sandboxRuns.projectId,
          organizationId: projects.organizationId,
          sessionId: sandboxRuns.sessionId,
          input: sandboxRuns.input,
        })
        .from(sandboxRuns)
        .innerJoin(projects, eq(projects.id, sandboxRuns.projectId))
        .where(eq(sandboxRuns.id, runId));
      if (!row) return null;
      const [start] = await db
        .select({ payload: sandboxCommands.payload })
        .from(sandboxCommands)
        .where(and(eq(sandboxCommands.runId, runId), eq(sandboxCommands.kind, "run.start")))
        .limit(1);
      return { runId, ...row, replay: replayOf(start?.payload) };
    },

    async sessionOwner(sessionId) {
      if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return null;
      const [row] = await db
        .select({ projectId: sandboxSessions.projectId, ownerUserId: sandboxSessions.ownerUserId })
        .from(sandboxSessions)
        .where(eq(sandboxSessions.id, sessionId));
      return row ?? null;
    },

    async pinned(sessionId, tool, argsKey) {
      const [row] = await db
        .select({ result: sandboxFakePins.result, isError: sandboxFakePins.isError })
        .from(sandboxFakePins)
        .where(
          and(
            eq(sandboxFakePins.sessionId, sessionId),
            eq(sandboxFakePins.tool, tool),
            eq(sandboxFakePins.argsKey, argsKey),
          ),
        );
      return row ?? null;
    },

    async pin(input) {
      await db
        .insert(sandboxFakePins)
        .values({
          sessionId: input.sessionId,
          tool: input.tool,
          argsKey: input.argsKey,
          result: input.result,
          isError: input.isError,
          pinnedBy: input.pinnedBy,
        })
        .onConflictDoUpdate({
          target: [sandboxFakePins.sessionId, sandboxFakePins.tool, sandboxFakePins.argsKey],
          set: {
            result: input.result,
            isError: input.isError,
            pinnedBy: input.pinnedBy,
            createdAt: sql`now()`,
          },
        });
    },

    async pins(sessionId) {
      if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return [];
      const rows = await db
        .select({
          tool: sandboxFakePins.tool,
          argsKey: sandboxFakePins.argsKey,
          result: sandboxFakePins.result,
          isError: sandboxFakePins.isError,
          createdAt: sandboxFakePins.createdAt,
        })
        .from(sandboxFakePins)
        .where(eq(sandboxFakePins.sessionId, sessionId))
        .orderBy(desc(sandboxFakePins.createdAt), sandboxFakePins.tool);
      return rows.map((row) => ({ ...row, args: parseJson(row.argsKey) }));
    },

    async unpin(sessionId, tool, argsKey) {
      if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return false;
      const removed = await db
        .delete(sandboxFakePins)
        .where(
          and(
            eq(sandboxFakePins.sessionId, sessionId),
            eq(sandboxFakePins.tool, tool),
            eq(sandboxFakePins.argsKey, argsKey),
          ),
        )
        .returning({ tool: sandboxFakePins.tool });
      return removed.length > 0;
    },

    async recordedCalls({ projectId, sessionId, tool, replay }) {
      const calls: RecordedCall[] = [];
      if (sessionId) {
        const result = await db.execute(sql`
          select c.payload->'args' as args, r.payload->'result' as result, coalesce((r.payload->>'isError')::boolean, false) as is_error
          from sandbox_runs run
          join sandbox_run_events c on c.run_id = run.id and c.kind = 'tool.call' and c.payload->>'tool' = ${tool}
          join sandbox_run_events r on r.run_id = run.id and r.kind = 'tool.result' and r.payload->>'callId' = c.payload->>'callId'
          where run.session_id = ${sessionId}
            and run.project_id = ${projectId}
            and (r.payload->>'mode' = 'real' or (r.payload->>'mode' = 'confirm' and r.payload->>'confirmDecision' = 'approve'))
          order by r.created_at desc
          limit ${RECORDED_LIMIT}
        `);
        for (const row of rowsOf<{ args: unknown; result: unknown; is_error: boolean }>(result))
          calls.push({ args: row.args, result: row.result, isError: row.is_error });
      }
      if (replay?.sourceTraceId || replay?.sourceSessionId) {
        const result = await db.execute(sql`
          select attributes->>'gen_ai.tool.call.arguments' as args, attributes->>'gen_ai.tool.call.result' as result, status_code
          from otel_spans
          where project_id = ${projectId}
            and operation_name = 'execute_tool'
            and attributes->>'gen_ai.tool.name' = ${tool}
            and ${notFake}
            and (trace_id = ${replay.sourceTraceId ?? null} or attributes->>'gen_ai.conversation.id' = ${replay.sourceSessionId ?? null})
          order by started_at desc
          limit ${RECORDED_LIMIT}
        `);
        calls.push(...rowsOf<SpanRow>(result).map(spanCall));
      }
      return calls;
    },

    async productionExamples(projectId, tool) {
      const result = await db.execute(sql`
        select attributes->>'gen_ai.tool.call.arguments' as args, attributes->>'gen_ai.tool.call.result' as result, status_code
        from otel_spans
        where project_id = ${projectId}
          and started_at > now() - make_interval(days => ${EXAMPLE_WINDOW_DAYS})
          and operation_name = 'execute_tool'
          and attributes->>'gen_ai.tool.name' = ${tool}
          and attributes ? 'gen_ai.tool.call.result'
          and ${notFake}
          and ${notPlayground}
        order by started_at desc
        limit ${EXAMPLE_POOL}
      `);
      return rowsOf<SpanRow>(result).map(spanCall);
    },

    async ledger(sessionId) {
      const [row] = await db
        .select({ state: sandboxSessions.fakeState })
        .from(sandboxSessions)
        .where(eq(sandboxSessions.id, sessionId));
      return (row?.state as FakeLedger | null) ?? {};
    },

    async saveLedger(sessionId, ledger) {
      await db
        .update(sandboxSessions)
        .set({ fakeState: ledger })
        .where(eq(sandboxSessions.id, sessionId));
    },

    async countGenerated(projectId, day) {
      const result = await db.execute(sql`
        insert into sandbox_fake_usage (project_id, day, generated) values (${projectId}, ${day}::date, 1)
        on conflict (project_id, day) do update set generated = sandbox_fake_usage.generated + 1
        returning generated
      `);
      return Number(rowsOf<{ generated: number }>(result)[0]!.generated);
    },
  };
}

interface SpanRow {
  args: string | null;
  result: string | null;
  status_code: number;
}

/**
 * Not a fake. The runner stamps `ratel.tool.mode` on its own `execute_tool`
 * span, but a framework span of the same call (the AI SDK's `ai.toolCall`,
 * also `execute_tool`) carries the result without the mode and is the parent
 * of the runner's span. So a span is a fake when it, or a child span of it,
 * says mode fake.
 */
const notFake = sql`coalesce(otel_spans.attributes->>'ratel.tool.mode', '') <> 'fake'
  and not exists (
    select 1 from otel_spans child
    where child.project_id = otel_spans.project_id
      and child.trace_id = otel_spans.trace_id
      and child.parent_span_id = otel_spans.span_id
      and child.attributes->>'ratel.tool.mode' = 'fake'
  )`;

/** A production span: playground runs (`deployment.environment.name=playground`) are never examples. */
const notPlayground = sql`coalesce(attributes->>'deployment.environment.name', '') <> 'playground'`;

function spanCall(row: SpanRow): RecordedCall {
  return {
    args: parseJson(row.args),
    result: parseJson(row.result),
    isError: Number(row.status_code) === 2,
  };
}

function replayOf(payload: unknown): FakeRunContext["replay"] {
  const replay = (
    payload as { replay?: { sourceTraceId?: unknown; sourceSessionId?: unknown } } | undefined
  )?.replay;
  if (!replay) return null;
  return {
    ...(typeof replay.sourceTraceId === "string" ? { sourceTraceId: replay.sourceTraceId } : {}),
    ...(typeof replay.sourceSessionId === "string"
      ? { sourceSessionId: replay.sourceSessionId }
      : {}),
  };
}

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}
