import { and, asc, eq, gte, inArray, lt, min, sql } from "drizzle-orm";
import { OTLP_MODEL_CALL } from "@/lib/ingest/otlp/derive-model-calls";
import { traceEvents } from "@/lib/ingest/trace-events/schema";
import { getDb } from "@/lib/platform/db/client";
import { traceTurnSteps, traceTurns } from "./schema";
import { toStepDraft } from "./turns/queries";
import type { StepDraft, TurnDraft, TurnEndedBy } from "./types";

/**
 * Reads of the closed-turn ledger: turns paged by `(ended_at, id)` with their steps, and
 * the few facts about a project's ledger as a whole that every reading above asks first
 * (is there one, how far back does it reach, did anything arrive). Every function takes
 * an injectable `db` so the jobs test against PGlite.
 *
 * Owned (ADR-0030): the reader half of upstream's `signals/ledger.ts`. The loaders of a
 * signal run's analysis context (catalog, usage, intent-graph clusters, previous runs)
 * read L4 tables and live with the readings.
 */

export type SignalsDb = ReturnType<typeof getDb>;

/** Turns per page; their steps load in one chunked read. */
export const TURN_PAGE_SIZE = 500;
const ID_CHUNK = 500;

/** Keyset position: the last turn of a page, `ended_at` as Postgres text (microseconds). */
export interface TurnCursor {
  endedAtRaw: string;
  id: string;
}

/** A closed turn as the readings consume it: the turn's facts and its steps. */
export interface ClosedTurn
  extends Pick<
    TurnDraft,
    | "sessionId"
    | "turnSource"
    | "lane"
    | "startedAt"
    | "endedAt"
    | "searchCount"
    | "invokeCount"
    | "errorCount"
    | "reSearchCount"
    | "abandoned"
    | "detour"
    | "firstTry"
  > {
  id: string;
  /** How the run ended (`gap`, `cap`, `next_turn`, `idle`). */
  endedBy: TurnEndedBy | null;
  /** The turn's hashed end user, when one was sent. */
  endUserKey: string | null;
  turnKey: string;
  steps: readonly StepDraft[];
}

export interface ClosedTurnPage {
  turns: ClosedTurn[];
  /** Null when the page was empty. */
  next: TurnCursor | null;
}

/** One page of closed turns ending in `[from, to)`, after `after`, oldest first. */
export async function listClosedTurnsPage(
  projectId: string,
  range: { from: Date; to: Date; after: TurnCursor | null },
  db: SignalsDb = getDb(),
  limit: number = TURN_PAGE_SIZE,
): Promise<ClosedTurnPage> {
  const keyset = range.after
    ? sql`(${traceTurns.endedAt}, ${traceTurns.id}) > (${range.after.endedAtRaw}::timestamptz, ${range.after.id}::uuid)`
    : undefined;
  const rows = await db
    .select({
      id: traceTurns.id,
      sessionId: traceTurns.sessionId,
      turnKey: traceTurns.turnKey,
      endUserKey: traceTurns.endUserKey,
      turnSource: traceTurns.turnSource,
      lane: traceTurns.lane,
      startedAt: traceTurns.startedAt,
      endedAt: traceTurns.endedAt,
      endedAtRaw: sql<string>`${traceTurns.endedAt}::text`,
      searchCount: traceTurns.searchCount,
      invokeCount: traceTurns.invokeCount,
      errorCount: traceTurns.errorCount,
      reSearchCount: traceTurns.reSearchCount,
      abandoned: traceTurns.abandoned,
      detour: traceTurns.detour,
      firstTry: traceTurns.firstTry,
      endedBy: traceTurns.endedBy,
    })
    .from(traceTurns)
    .where(
      and(
        eq(traceTurns.projectId, projectId),
        eq(traceTurns.status, "closed"),
        gte(traceTurns.endedAt, range.from),
        lt(traceTurns.endedAt, range.to),
        keyset,
      ),
    )
    .orderBy(asc(traceTurns.endedAt), asc(traceTurns.id))
    .limit(limit);
  const last = rows.at(-1);
  if (!last) return { turns: [], next: null };
  const steps = await loadStepsByTurn(
    rows.map((r) => r.id),
    db,
  );
  const turns: ClosedTurn[] = rows.map((row) => ({
    id: row.id,
    sessionId: row.sessionId,
    turnKey: row.turnKey,
    endUserKey: row.endUserKey,
    turnSource: row.turnSource as ClosedTurn["turnSource"],
    lane: row.lane as ClosedTurn["lane"],
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    searchCount: row.searchCount,
    invokeCount: row.invokeCount,
    errorCount: row.errorCount,
    reSearchCount: row.reSearchCount,
    abandoned: row.abandoned,
    detour: row.detour,
    firstTry: row.firstTry,
    endedBy: (row.endedBy ?? null) as TurnEndedBy | null,
    steps: steps.get(row.id) ?? [],
  }));
  return { turns, next: { endedAtRaw: last.endedAtRaw, id: last.id } };
}

/** Steps of the given turns, keyed by turn id, in ordinal order. */
export async function loadStepsByTurn(
  turnIds: readonly string[],
  db: Pick<SignalsDb, "select"> = getDb(),
): Promise<Map<string, StepDraft[]>> {
  const out = new Map<string, StepDraft[]>();
  for (let i = 0; i < turnIds.length; i += ID_CHUNK) {
    const ids = turnIds.slice(i, i + ID_CHUNK);
    const rows = await db
      .select()
      .from(traceTurnSteps)
      .where(inArray(traceTurnSteps.turnId, ids))
      .orderBy(asc(traceTurnSteps.turnId), asc(traceTurnSteps.ordinal));
    for (const row of rows) {
      out.set(row.turnId, [...(out.get(row.turnId) ?? []), toStepDraft(row)]);
    }
  }
  return out;
}

/** Closed turns ending in `[from, to)`: the page's reading before a run exists. */
export async function countClosedTurns(
  projectId: string,
  from: Date,
  to: Date,
  db: Pick<SignalsDb, "select"> = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(traceTurns)
    .where(
      and(
        eq(traceTurns.projectId, projectId),
        eq(traceTurns.status, "closed"),
        gte(traceTurns.endedAt, from),
        lt(traceTurns.endedAt, to),
      ),
    );
  return row?.n ?? 0;
}

/**
 * Whether OpenTelemetry model calls arrived since `since` (one row is enough). Read only
 * when no run exists: model calls without tool spans never make one.
 */
export async function hasModelCallsSince(
  projectId: string,
  since: Date,
  db: Pick<SignalsDb, "select"> = getDb(),
): Promise<boolean> {
  const rows = await db
    .select({ one: sql`1` })
    .from(traceEvents)
    .where(
      and(
        eq(traceEvents.projectId, projectId),
        eq(traceEvents.type, OTLP_MODEL_CALL),
        gte(traceEvents.receivedAt, since),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Whether the project has any turn at all, open or closed. */
export async function hasLedger(
  projectId: string,
  db: Pick<SignalsDb, "select"> = getDb(),
): Promise<boolean> {
  const rows = await db
    .select({ one: sql`1` })
    .from(traceTurns)
    .where(eq(traceTurns.projectId, projectId))
    .limit(1);
  return rows.length > 0;
}

/** The earliest closed turn's end: how far back the ledger reaches. */
export async function ledgerStartedAt(
  projectId: string,
  db: Pick<SignalsDb, "select"> = getDb(),
): Promise<Date | null> {
  const [row] = await db
    .select({ at: min(traceTurns.endedAt) })
    .from(traceTurns)
    .where(and(eq(traceTurns.projectId, projectId), eq(traceTurns.status, "closed")));
  return row?.at ?? null;
}
