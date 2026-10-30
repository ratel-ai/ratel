import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { traceEvents } from "@/lib/ingest/trace-events/schema";
import { traceTurnSteps } from "@/lib/ledger/schema";
import { getDb } from "@/lib/platform/db/client";
import { envNumber } from "@/lib/platform/env-number";
import { getLogger } from "@/lib/platform/logger";
import { reportServerException } from "@/lib/platform/telemetry";
import {
  LINK_CHAIN_MAX_MS,
  LINK_LEAD_MS,
  type LinkCandidate,
  linkTurns,
  type RunTraces,
} from "@/lib/readings/trace-signals/signals/linked-runs";
import { OTLP_MODEL_CALL_TYPE } from "@/lib/readings/trace-signals/signals/otel-facts";
import type { SignalTurn } from "@/lib/readings/trace-signals/signals/types";

/**
 * The read behind linking a page of SDK runs to their OpenTelemetry model
 * calls: the `otlp_model_call` rows of the page's runtime-lane sessions over
 * the page's time span (widened by the link window), paged by event time.
 *
 * Index: `trace_events_project_type_time_idx` (project, type, event time),
 * with session filtered in place. Pages of turns come in `ended_at` order, so
 * across a run the reads cover the window's model calls about once. Bounded:
 * at most {@link MAX_LINK_ROWS} rows per page of turns (logged when cut), and
 * only the fields linking needs, never the whole payload.
 */

const logger = getLogger("trace-signals/linked-runs");

export type LinkedRunsDb = Pick<ReturnType<typeof getDb>, "select">;

const PAGE_SIZE = 5_000;
export const MAX_LINK_ROWS = Math.floor(envNumber("TRACE_SIGNALS_MAX_LINK_ROWS", 100_000));

const eventTime = sql`coalesce(${traceEvents.occurredAt}, ${traceEvents.receivedAt})`;

interface Cursor {
  atRaw: string;
  id: string;
}

interface Span {
  sessionIds: string[];
  from: Date;
  to: Date;
}

/** Which calls a read takes: those of the sessions, or those of the traces. */
type Scope = { by: "session"; ids: string[] } | { by: "trace"; ids: string[] };

type RawRow = LinkCandidate & { atRaw: string };

async function readPage(
  projectId: string,
  span: Span,
  scope: Scope,
  after: Cursor | null,
  db: LinkedRunsDb,
): Promise<RawRow[]> {
  const keyset = after
    ? sql`(${eventTime}, ${traceEvents.id}) > (${after.atRaw}::timestamptz, ${after.id}::uuid)`
    : undefined;
  const rows = await db
    .select({
      id: traceEvents.id,
      sessionId: sql<string>`${traceEvents.sessionId}`,
      atMs: sql<number>`(extract(epoch from ${eventTime}) * 1000)::float8`,
      tookMs: traceEvents.tookMs,
      inputTokens: traceEvents.inputTokens,
      outputTokens: traceEvents.outputTokens,
      model: sql<string | null>`${traceEvents.payload} ->> 'model'`,
      prompt: sql<string | null>`${traceEvents.payload} ->> 'prompt'`,
      menu: sql<
        string[] | null
      >`case jsonb_typeof(${traceEvents.payload} -> 'menu') when 'array' then ${traceEvents.payload} -> 'menu' end`,
      traceId: traceEvents.traceId,
      atRaw: sql<string>`${eventTime}::text`,
    })
    .from(traceEvents)
    .where(
      and(
        eq(traceEvents.projectId, projectId),
        eq(traceEvents.type, OTLP_MODEL_CALL_TYPE),
        sql`${eventTime} >= ${span.from.toISOString()}::timestamptz`,
        sql`${eventTime} <= ${span.to.toISOString()}::timestamptz`,
        scope.by === "session"
          ? inArray(traceEvents.sessionId, scope.ids)
          : inArray(traceEvents.traceId, scope.ids),
        keyset,
      ),
    )
    .orderBy(asc(eventTime), asc(traceEvents.id))
    .limit(PAGE_SIZE);
  return rows.map((row) => ({ ...row, atMs: Number(row.atMs) }));
}

/** The span a page of runtime-lane turns reads model calls over; null without such turns. */
export type LinkSpanTurn = Pick<SignalTurn, "lane" | "sessionId" | "startedAt" | "endedAt">;

export function linkSpanOf(turns: readonly LinkSpanTurn[]): Span | null {
  const runs = turns.filter((turn) => turn.lane === "runtime");
  if (runs.length === 0) return null;
  return {
    sessionIds: [...new Set(runs.map((turn) => turn.sessionId))].sort(),
    from: new Date(Math.min(...runs.map((turn) => turn.startedAt.getTime())) - LINK_LEAD_MS),
    to: new Date(Math.max(...runs.map((turn) => turn.endedAt.getTime())) + LINK_CHAIN_MAX_MS),
  };
}

async function readScope(
  projectId: string,
  span: Span,
  scope: Scope,
  maxRows: number,
  db: LinkedRunsDb,
): Promise<{ rows: LinkCandidate[]; truncated: boolean }> {
  const out: LinkCandidate[] = [];
  let after: Cursor | null = null;
  while (out.length < maxRows) {
    const rows = await readPage(projectId, span, scope, after, db);
    out.push(...rows.slice(0, maxRows - out.length).map(({ atRaw: _atRaw, ...row }) => row));
    const last = rows.at(-1);
    if (!last || rows.length < PAGE_SIZE) return { rows: out, truncated: false };
    after = { atRaw: last.atRaw, id: last.id };
  }
  return { rows: out, truncated: true };
}

/**
 * The model calls that may link to a page of turns, at most `maxRows`: those
 * of the page's sessions, plus those of `traceIds` (the traces the page's SDK
 * events carried) whatever their session.
 */
export async function loadLinkCandidates(
  projectId: string,
  turns: readonly LinkSpanTurn[],
  db: LinkedRunsDb = getDb(),
  maxRows: number = MAX_LINK_ROWS,
  traceIds: readonly string[] = [],
): Promise<LinkCandidate[]> {
  const span = linkSpanOf(turns);
  if (!span) return [];
  const bySession = await readScope(
    projectId,
    span,
    { by: "session", ids: span.sessionIds },
    maxRows,
    db,
  );
  let truncated = bySession.truncated;
  const out = bySession.rows;
  const traces = [...new Set(traceIds)].sort();
  if (traces.length > 0 && out.length < maxRows) {
    const seen = new Set(out.map((row) => row.id));
    for (const ids of chunks(traces, ID_CHUNK)) {
      const byTrace = await readScope(
        projectId,
        span,
        { by: "trace", ids },
        maxRows - out.length,
        db,
      );
      out.push(...byTrace.rows.filter((row) => !seen.has(row.id)));
      truncated ||= byTrace.truncated;
      if (out.length >= maxRows) break;
    }
  }
  if (truncated)
    logger.warn(
      { project_id: projectId, max_rows: maxRows },
      "linked model calls truncated for trace signals",
    );
  return out;
}

const ID_CHUNK = 500;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * The trace ids the SDK stamped on each runtime run's events (an OTel span
 * was active), by run id. Reads the runs' steps joined to their events.
 */
export async function loadRunTraces(
  projectId: string,
  runIds: readonly string[],
  db: LinkedRunsDb = getDb(),
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  for (const ids of chunks([...new Set(runIds)], ID_CHUNK)) {
    const rows = await db
      .select({ turnId: traceTurnSteps.turnId, traceId: traceEvents.traceId })
      .from(traceTurnSteps)
      .innerJoin(traceEvents, eq(traceEvents.id, traceTurnSteps.traceEventId))
      .where(
        and(
          inArray(traceTurnSteps.turnId, ids),
          eq(traceEvents.projectId, projectId),
          isNotNull(traceEvents.traceId),
        ),
      )
      .groupBy(traceTurnSteps.turnId, traceEvents.traceId);
    for (const row of rows) {
      if (!row.traceId) continue;
      out.set(row.turnId, (out.get(row.turnId) ?? new Set<string>()).add(row.traceId));
    }
  }
  return out;
}

/**
 * A page of turns with its SDK runs linked to their model calls. Fails soft:
 * a failed read is logged and reported, and the page goes on unlinked.
 */
export async function linkRunsPage(
  projectId: string,
  turns: readonly SignalTurn[],
  db: LinkedRunsDb = getDb(),
): Promise<SignalTurn[]> {
  try {
    const runIds = turns.filter((turn) => turn.lane === "runtime").map((turn) => turn.id);
    const runTraces: RunTraces =
      runIds.length > 0 ? await loadRunTraces(projectId, runIds, db) : new Map();
    const traceIds = [...runTraces.values()].flatMap((ids) => [...ids]);
    return linkTurns(
      turns,
      await loadLinkCandidates(projectId, turns, db, MAX_LINK_ROWS, traceIds),
      runTraces,
    );
  } catch (err) {
    logger.error({ err, project_id: projectId }, "linked model calls unreadable for trace signals");
    reportServerException(err, "system:trace-signals", {
      project_id: projectId,
      operation: "trace_signals_link_runs",
    });
    return [...turns];
  }
}
