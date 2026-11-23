import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { events } from "@/lib/ingest/otlp/schema";
import { traceEvents } from "@/lib/ingest/trace-events/schema";
import { traceTurnSteps, traceTurns } from "@/lib/ledger/schema";
import { getDb } from "@/lib/platform/db/client";
import type { StoredAlias } from "@/lib/readings/trace-signals/hallucinations/run";
import { traceHallucinations, traceTurnOutcomes } from "@/lib/readings/trace-signals/schema";
import { latestSignalRun } from "@/lib/readings/trace-signals/signals/queries";
import type { PageFinding } from "@/lib/views/health/hallucinations/page-model";

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

/**
 * What the window holds for each group's rules to read, as yes or no: the
 * tool name the agent asked for (`requested_tool_id`), an error in words (not
 * just a type id like `tool_error`), and the agent's replies or the person's
 * reactions. A group with nothing to read is not checked, whatever it finds.
 */
export interface HallucinationCoverage {
  requestedToolIds: boolean;
  errorText: boolean;
  replies: boolean;
  reactions: boolean;
}

export async function loadCoverage(
  projectId: string,
  window: PageWindow,
  db: PageDb = getDb(),
): Promise<HallucinationCoverage> {
  const at = sql`coalesce(${traceEvents.occurredAt}, ${traceEvents.receivedAt})`;
  const inWindow = and(
    eq(traceEvents.projectId, projectId),
    sql`${at} >= ${window.from} and ${at} < ${window.to}`,
  );
  const exists = async (query: Promise<unknown[]>) => (await query).length > 0;
  const [requestedToolIds, errorText, replies, reactions] = await Promise.all([
    exists(
      db
        .select({ one: sql`1` })
        .from(traceEvents)
        .where(and(inWindow, sql`${traceEvents.payload} ? 'requested_tool_id'`))
        .limit(1),
    ),
    exists(
      db
        .select({ one: sql`1` })
        .from(traceEvents)
        .where(and(inWindow, sql`${traceEvents.errorMessage} ~ '\\s'`))
        .limit(1),
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
            sql`(${traceTurnOutcomes.modelVersion} is not null or ${traceTurnOutcomes.replyReaction} is not null)`,
          ),
        )
        .limit(1),
    ),
  ]);
  return { requestedToolIds, errorText, replies, reactions };
}

/**
 * When the reading last ran for the project (the newest signal run whose
 * summary carries it; null when it never has), and the name aliases it left
 * out of the findings.
 */
export async function loadLastRead(
  projectId: string,
  db: PageDb = getDb(),
): Promise<{ at: Date | null; aliases: StoredAlias[] }> {
  const run = await latestSignalRun(projectId, db, "completed");
  const summary = run?.summary as
    | { hallucinations?: { aliases?: StoredAlias[] } }
    | null
    | undefined;
  if (!run || !summary?.hallucinations) return { at: null, aliases: [] };
  return {
    at: run.createdAt,
    aliases: Array.isArray(summary.hallucinations.aliases) ? summary.hallucinations.aliases : [],
  };
}
