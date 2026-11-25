import { and, desc, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { events } from "@/lib/ingest/otlp/schema";
import { traceEvents } from "@/lib/ingest/trace-events/schema";
import { traceTurnSteps, traceTurns } from "@/lib/ledger/schema";
import { getDb } from "@/lib/platform/db/client";
import {
  type BoundReadDb,
  supplementaryReadTimeoutMs,
  withStatementTimeout,
} from "@/lib/platform/db/statement-timeout";
import type { StoredAlias } from "@/lib/readings/trace-signals/hallucinations/run";
import {
  traceHallucinations,
  traceSignalRuns,
  traceTurnOutcomes,
} from "@/lib/readings/trace-signals/schema";
import type { PageCoverage, PageFinding } from "@/lib/views/health/hallucinations/page-model";

/**
 * The Hallucinations page's reads: the window's findings with the turn they
 * sit in and the call's event (to open it in Traces), how many turns the
 * window holds, and when the reading last ran. Closed values and ids only.
 */

export type PageDb = Pick<ReturnType<typeof getDb>, "select">;

export interface PageWindow {
  from: Date;
  to: Date;
}

/** Findings read at most: a window with more is capped, newest first. */
export const MAX_PAGE_FINDINGS = 10_000;

export async function loadPageFindings(
  projectId: string,
  window: PageWindow,
  db: PageDb = getDb(),
  max: number = MAX_PAGE_FINDINGS,
): Promise<{ findings: PageFinding[]; capped: boolean }> {
  const rows = await db
    .select({
      id: traceHallucinations.id,
      turnId: traceHallucinations.turnId,
      sessionId: traceTurns.sessionId,
      stepOrdinal: traceHallucinations.stepOrdinal,
      // The call's own event, to ring it in Traces; null once the step is gone.
      eventId: traceTurnSteps.traceEventId,
      kind: traceHallucinations.kind,
      toolId: traceHallucinations.toolId,
      requestedToolId: traceHallucinations.requestedToolId,
      repeats: traceHallucinations.repeats,
      worked: traceHallucinations.worked,
      occurredAt: traceHallucinations.occurredAt,
    })
    .from(traceHallucinations)
    .innerJoin(traceTurns, eq(traceTurns.id, traceHallucinations.turnId))
    .leftJoin(
      traceTurnSteps,
      and(
        eq(traceTurnSteps.turnId, traceHallucinations.turnId),
        eq(traceTurnSteps.ordinal, traceHallucinations.stepOrdinal),
      ),
    )
    .where(
      and(
        eq(traceHallucinations.projectId, projectId),
        gte(traceHallucinations.occurredAt, window.from),
        lt(traceHallucinations.occurredAt, window.to),
      ),
    )
    .orderBy(desc(traceHallucinations.occurredAt), desc(traceHallucinations.id))
    .limit(max + 1);
  return { findings: rows.slice(0, max), capped: rows.length > max };
}

/** Closed turns that ended in the window: what the rate is over. */
export async function countWindowTurns(
  projectId: string,
  window: PageWindow,
  db: PageDb = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(traceTurns)
    .where(
      and(
        eq(traceTurns.projectId, projectId),
        eq(traceTurns.status, "closed"),
        gte(traceTurns.endedAt, window.from),
        lt(traceTurns.endedAt, window.to),
      ),
    );
  return row?.n ?? 0;
}

const CALL_EVENT_TYPES = ["invoke_start", "invoke_end", "invoke_error"];

type Bound = <T>(
  read: (db: BoundReadDb) => Promise<T>,
  options: { operation: string; timeoutMs: number | null },
) => Promise<T>;

/**
 * Whether `read` finds a row, under the supplementary read timeout. A probe
 * that runs out of time reads as no: an `exists` that found no row early
 * has scanned a lot and found nothing.
 */
export async function boundedExists(
  operation: string,
  read: (db: BoundReadDb) => Promise<unknown[]>,
  bound: Bound,
): Promise<boolean> {
  try {
    return (await bound(read, { operation, timeoutMs: supplementaryReadTimeoutMs() })).length > 0;
  } catch {
    return false;
  }
}

/**
 * What the window holds for each group's rules to read (`PageCoverage`), as
 * yes or no: the tool name the agent asked for (`requested_tool_id`), an error
 * in words (not just a type id like `tool_error`), the agent's replies, and
 * whether a model read the window's turns (`trace_turn_outcomes.model_version`).
 * A group with nothing to read is not checked, whatever it finds.
 */
export async function loadCoverage(
  projectId: string,
  window: PageWindow,
  db: PageDb = getDb(),
): Promise<PageCoverage> {
  const at = sql`coalesce(${traceEvents.occurredAt}, ${traceEvents.receivedAt})`;
  // Only call events carry an asked-for name or an error, and naming their types lets the
  // (project, type, time) index answer: without it a project that sends neither is scanned in full.
  const inWindow = and(
    eq(traceEvents.projectId, projectId),
    inArray(traceEvents.type, CALL_EVENT_TYPES),
    sql`${at} >= ${window.from} and ${at} < ${window.to}`,
  );
  const exists = async (query: Promise<unknown[]>) => (await query).length > 0;
  const [requestedToolIds, errorText, replies, modelReads] = await Promise.all([
    boundedExists(
      "hallucinations_coverage_requested",
      (bound) =>
        bound
          .select({ one: sql`1` })
          .from(traceEvents)
          .where(and(inWindow, sql`${traceEvents.payload} ? 'requested_tool_id'`))
          .limit(1),
      (read, options) => withStatementTimeout(read, { ...options, db: db as never }),
    ),
    boundedExists(
      "hallucinations_coverage_error_text",
      (bound) =>
        bound
          .select({ one: sql`1` })
          .from(traceEvents)
          .where(and(inWindow, sql`${traceEvents.errorMessage} ~ '\\s'`))
          .limit(1),
      (read, options) => withStatementTimeout(read, { ...options, db: db as never }),
    ),
    exists(
      db
        .select({ one: sql`1` })
        .from(events)
        .where(
          and(
            eq(events.projectId, projectId),
            gte(events.occurredAt, window.from),
            lt(events.occurredAt, window.to),
            sql`jsonb_typeof(${events.payload} -> 'messages') = 'array'`,
          ),
        )
        .limit(1),
    ),
    exists(
      db
        .select({ one: sql`1` })
        .from(traceTurnOutcomes)
        .where(
          and(
            eq(traceTurnOutcomes.projectId, projectId),
            gte(traceTurnOutcomes.endedAt, window.from),
            lt(traceTurnOutcomes.endedAt, window.to),
            isNotNull(traceTurnOutcomes.modelVersion),
          ),
        )
        .limit(1),
    ),
  ]);
  return { requestedToolIds, errorText, replies, modelReads };
}

/**
 * When the reading last ran in full for the project (the newest completed
 * signal run whose summary carries its counts; null when it never has), the
 * name aliases it left out of the findings, and when a newer run ran out of
 * time before it was done (`partialAt`; null when none did).
 */
export async function loadLastRead(
  projectId: string,
  db: PageDb = getDb(),
): Promise<{ at: Date | null; aliases: StoredAlias[]; partialAt: Date | null }> {
  // A run whose reading failed has no `hallucinations` in its summary; one that ran out of time has `partial`.
  const newestWith = (full: boolean) =>
    db
      .select({ createdAt: traceSignalRuns.createdAt, summary: traceSignalRuns.summary })
      .from(traceSignalRuns)
      .where(
        and(
          eq(traceSignalRuns.projectId, projectId),
          eq(traceSignalRuns.status, "completed"),
          sql`${traceSignalRuns.summary} ? 'hallucinations'`,
          full
            ? sql`not coalesce((${traceSignalRuns.summary} -> 'hallucinations' ->> 'partial')::boolean, false)`
            : undefined,
        ),
      )
      .orderBy(desc(traceSignalRuns.createdAt))
      .limit(1);
  const [[full], [newest]] = await Promise.all([newestWith(true), newestWith(false)]);
  const partialAt =
    newest && (!full || newest.createdAt > full.createdAt) ? newest.createdAt : null;
  if (!full) return { at: null, aliases: [], partialAt };
  const aliases = (full.summary as { hallucinations?: { aliases?: StoredAlias[] } } | null)
    ?.hallucinations?.aliases;
  return { at: full.createdAt, aliases: Array.isArray(aliases) ? aliases : [], partialAt };
}
