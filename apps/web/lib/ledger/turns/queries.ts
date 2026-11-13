import {
  and,
  asc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNull,
  notExists,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { traceEventHits, traceEvents } from "@/lib/ingest/trace-events/schema";
import { jobs } from "@/lib/jobs/schema";
import { getDb } from "@/lib/platform/db/client";
import { projects } from "@/lib/platform/projects/schema";
import {
  TURN_BUILD_DUE_LIMIT,
  TURN_BUILD_ERROR_BACKOFF_MS,
  TURN_BUILD_PAGE_LIMIT,
  TURN_BUILD_SEED_WINDOW_DAYS,
  TURN_EVENT_TYPES,
  TURN_IDLE_CLOSE_MS,
} from "../constants";
import { isRunTrigger, type RunTrigger } from "../run-trigger";
import {
  type NewTraceTurnRow,
  type NewTraceTurnStepRow,
  type TraceTurnStepRow,
  traceTurnSteps,
  traceTurns,
} from "../schema";
import type {
  InvokeOutcome,
  SearchType,
  StepDraft,
  StoredTurn,
  TargetType,
  TurnDraft,
  TurnEventHit,
  TurnEventRow,
  TurnEventType,
  TurnLane,
  TurnSource,
} from "../types";
import type { ReloadReach } from "./build-turn";

/**
 * The database layer of the turn ledger. Every function takes an injectable `db` so the
 * build job tests against PGlite, like the rest of `lib/`. Owned (ADR-0030): the
 * run-trigger vocabulary comes from `../run-trigger` instead of the L4 signal queries.
 */

export type TraceTurnsDb = ReturnType<typeof getDb>;

/** Ids per `IN (...)` chunk, well under Postgres's bind-parameter cap. */
const ID_CHUNK = 500;
/** Turn rows per upsert statement (25 columns each). */
const TURN_UPSERT_CHUNK = 200;
/** Step rows per insert statement (30 columns each). */
const STEP_INSERT_CHUNK = 500;

// --- cursor --------------------------------------------------------------------

export interface TraceTurnsCursor {
  /** `received_at` exactly as Postgres holds it (microseconds). Compare and
   * advance with this, never with the millisecond Date. */
  raw: string;
  at: Date;
}

/** The project's build cursor, or null before the first build. */
export async function getTraceTurnsCursor(
  projectId: string,
  db: TraceTurnsDb = getDb(),
): Promise<TraceTurnsCursor | null> {
  const [row] = await db
    .select({
      raw: sql<string | null>`${projects.traceTurnsBuiltThrough}::text`,
      at: projects.traceTurnsBuiltThrough,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!row?.raw || !row.at) return null;
  return { raw: row.raw, at: row.at };
}

/** A cursor value as a SQL timestamptz: a string is the DB's own text, cast back
 * without losing the microseconds a JS Date cannot carry. */
function cursorValue(through: Date | string): SQL {
  return typeof through === "string" ? sql`${through}::timestamptz` : sql`${through}`;
}

function advanceCursorSet(through: Date | string) {
  const value = cursorValue(through);
  // Never backwards: two runs racing must not rewind it.
  return {
    traceTurnsBuiltThrough: sql`greatest(coalesce(${projects.traceTurnsBuiltThrough}, ${value}), ${value})`,
  };
}

// --- event pager ---------------------------------------------------------------

export interface TurnEventPageRow extends TurnEventRow {
  /** `received_at` as Postgres text, for the cursor. */
  receivedAtRaw: string;
}

/**
 * One page of turn events received after `since`, oldest first by
 * `(received_at, event time, id)`.
 *
 * Tie completion: every event of one ingest request shares the insert transaction's
 * `received_at`, so a page that ends mid-timestamp would split a batch, and the strict
 * `>` cursor would then skip the rest of it forever. When a page comes back full, the
 * remainder of the last timestamp is appended, so the cursor always lands on a complete
 * boundary. A page is therefore at most `limit + one batch`.
 */
export async function listTurnEventsPage(
  projectId: string,
  since: Date | string,
  db: TraceTurnsDb = getDb(),
  limit: number = TURN_BUILD_PAGE_LIMIT,
): Promise<TurnEventPageRow[]> {
  const after = cursorValue(since);
  const columns = {
    id: traceEvents.id,
    type: traceEvents.type,
    sessionId: traceEvents.sessionId,
    sourceId: traceEvents.sourceId,
    ingestSource: traceEvents.ingestSource,
    occurredAt: traceEvents.occurredAt,
    receivedAt: traceEvents.receivedAt,
    receivedAtRaw: sql<string>`${traceEvents.receivedAt}::text`,
    // Envelope field.
    turnId: sql<string | null>`${traceEvents.payload} ->> 'turn_id'`,
    invocationId: traceEvents.invocationId,
    traceId: traceEvents.traceId,
    toolId: traceEvents.toolId,
    skillId: traceEvents.skillId,
    query: traceEvents.query,
    topK: traceEvents.topK,
    hitCount: traceEvents.hitCount,
    tookMs: traceEvents.tookMs,
    endUserId: traceEvents.endUserId,
    // Set by OTLP ingest on a tool call that is its trace's root span.
    rootTool: sql<boolean>`coalesce((${traceEvents.payload} ->> 'root_tool') = 'true', false)`,
  };
  const inTypes = inArray(traceEvents.type, [...TURN_EVENT_TYPES]);
  const eventTime = sql`coalesce(${traceEvents.occurredAt}, ${traceEvents.receivedAt})`;
  const page = await db
    .select(columns)
    .from(traceEvents)
    .where(
      and(eq(traceEvents.projectId, projectId), inTypes, sql`${traceEvents.receivedAt} > ${after}`),
    )
    .orderBy(asc(traceEvents.receivedAt), asc(eventTime), asc(traceEvents.id))
    .limit(limit);
  const rows = page.map(toPageRow);
  const last = rows[rows.length - 1];
  if (rows.length < limit || !last) return rows;
  // Re-read the whole last timestamp rather than "after the last id": the
  // page's tail is ordered by event time, not id, so an id cut would be wrong.
  const seen = new Set(rows.map((r) => r.id));
  const rest = await db
    .select(columns)
    .from(traceEvents)
    .where(
      and(
        eq(traceEvents.projectId, projectId),
        inTypes,
        sql`${traceEvents.receivedAt} = ${last.receivedAtRaw}::timestamptz`,
      ),
    )
    .orderBy(asc(eventTime), asc(traceEvents.id));
  return rows.concat(rest.map(toPageRow).filter((r) => !seen.has(r.id)));
}

function toPageRow<T extends { receivedAt: Date | string; occurredAt: Date | string | null }>(
  r: T,
): Omit<T, "receivedAt" | "occurredAt"> & { receivedAt: Date; occurredAt: Date | null } {
  return {
    ...r,
    receivedAt: r.receivedAt instanceof Date ? r.receivedAt : new Date(r.receivedAt),
    occurredAt:
      r.occurredAt === null
        ? null
        : r.occurredAt instanceof Date
          ? r.occurredAt
          : new Date(r.occurredAt),
  };
}

/** Ranked hits for a set of search events, keyed by event id, rank ascending. */
export async function listTurnEventHits(
  eventIds: readonly string[],
  db: TraceTurnsDb = getDb(),
): Promise<Map<string, TurnEventHit[]>> {
  const out = new Map<string, TurnEventHit[]>();
  for (const ids of chunked(eventIds, ID_CHUNK)) {
    const rows = await db
      .select({
        traceEventId: traceEventHits.traceEventId,
        rank: traceEventHits.rank,
        targetType: traceEventHits.targetType,
        targetId: traceEventHits.targetId,
        score: traceEventHits.score,
      })
      .from(traceEventHits)
      .where(inArray(traceEventHits.traceEventId, [...ids]))
      .orderBy(asc(traceEventHits.traceEventId), asc(traceEventHits.rank));
    for (const row of rows) {
      const list = out.get(row.traceEventId) ?? [];
      list.push({
        rank: row.rank,
        targetType: row.targetType,
        targetId: row.targetId,
        score: row.score,
      });
      out.set(row.traceEventId, list);
    }
  }
  return out;
}

// --- ledger reads ----------------------------------------------------------------

/**
 * The stored turns a page can change: for the page's sessions, every open turn, the
 * idle-closed one (new events may continue it), any turn whose declared key the page
 * names again (a late event of a declared turn), and the closed turns within the page's
 * {@link ReloadReach}: every turn that ended inside the gateway dedupe window, and in a
 * session still holding an unpaired `invoke_start` inside the pairing window, every turn
 * that ended since then. Both reach predicates run on the `(project_id, session_id, ...)`
 * indexes and are bounded by the page's sessions and a window of minutes.
 */
export async function loadReloadableTurns(
  projectId: string,
  sessionIds: readonly string[],
  declaredKeys: readonly string[],
  reach: ReloadReach | null,
  db: TraceTurnsDb = getDb(),
): Promise<StoredTurn[]> {
  const turns: StoredTurn[] = [];
  for (const sessions of chunked(sessionIds, ID_CHUNK)) {
    const reachable = reach ? reachPredicate(projectId, sessions, reach, db) : undefined;
    const rows = await db
      .select({
        id: traceTurns.id,
        sessionId: traceTurns.sessionId,
        sourceId: traceTurns.sourceId,
        turnKey: traceTurns.turnKey,
        turnSource: traceTurns.turnSource,
        lane: traceTurns.lane,
        endUserKey: traceTurns.endUserKey,
      })
      .from(traceTurns)
      .where(
        and(
          eq(traceTurns.projectId, projectId),
          inArray(traceTurns.sessionId, [...sessions]),
          or(
            eq(traceTurns.status, "open"),
            eq(traceTurns.endedBy, "idle"),
            declaredKeys.length > 0 ? inArray(traceTurns.turnKey, [...declaredKeys]) : undefined,
            reachable,
          ),
        ),
      )
      .orderBy(asc(traceTurns.startedAt), asc(traceTurns.id));
    for (const row of rows) {
      turns.push({
        ...row,
        turnSource: row.turnSource as TurnSource,
        lane: row.lane as TurnLane,
        steps: [],
      });
    }
  }
  if (turns.length === 0) return turns;
  const steps = await loadSteps(
    turns.map((t) => t.id),
    db,
  );
  return turns.map((t) => ({ ...t, steps: steps.get(t.id) ?? [] }));
}

/** The closed turns a page reaches (see {@link reloadReach}), for one chunk of sessions.
 * The pending-start subquery is uncorrelated: it names the sessions once, and the outer
 * predicate takes every turn of those that ended since. */
function reachPredicate(
  projectId: string,
  sessions: readonly string[],
  reach: ReloadReach,
  db: TraceTurnsDb,
): SQL | undefined {
  const pendingSessions = db
    .selectDistinct({ sessionId: traceTurns.sessionId })
    .from(traceTurns)
    .innerJoin(traceTurnSteps, eq(traceTurnSteps.turnId, traceTurns.id))
    .where(
      and(
        eq(traceTurns.projectId, projectId),
        inArray(traceTurns.sessionId, [...sessions]),
        gte(traceTurns.endedAt, reach.pairingFloor),
        eq(traceTurnSteps.eventType, "invoke_start"),
        isNull(traceTurnSteps.endTraceEventId),
        gte(traceTurnSteps.occurredAt, reach.pairingFloor),
      ),
    );
  return or(
    gte(traceTurns.endedAt, reach.gatewayFloor),
    and(
      gte(traceTurns.endedAt, reach.pairingFloor),
      inArray(traceTurns.sessionId, pendingSessions),
    ),
  );
}

async function loadSteps(
  turnIds: readonly string[],
  db: TraceTurnsDb,
): Promise<Map<string, StepDraft[]>> {
  const out = new Map<string, StepDraft[]>();
  for (const ids of chunked(turnIds, ID_CHUNK)) {
    const rows = await db
      .select()
      .from(traceTurnSteps)
      .where(inArray(traceTurnSteps.turnId, [...ids]))
      .orderBy(asc(traceTurnSteps.turnId), asc(traceTurnSteps.ordinal));
    for (const row of rows) {
      const list = out.get(row.turnId) ?? [];
      list.push(toStepDraft(row));
      out.set(row.turnId, list);
    }
  }
  return out;
}

/** A stored step row as the pure builder's shape. */
export function toStepDraft(row: TraceTurnStepRow): StepDraft {
  return {
    ordinal: row.ordinal,
    kind: row.kind as StepDraft["kind"],
    eventType: row.eventType as TurnEventType,
    traceEventId: row.traceEventId,
    endTraceEventId: row.endTraceEventId,
    declared: row.declared,
    occurredAt: row.occurredAt,
    receivedAt: row.receivedAt,
    endOccurredAt: row.endOccurredAt,
    endReceivedAt: row.endReceivedAt,
    gapMs: row.gapMs,
    searchOrdinal: row.searchOrdinal,
    searchType: row.searchType as SearchType | null,
    queryHash: row.queryHash,
    topK: row.topK,
    hitCount: row.hitCount,
    hitIds: row.hitIds,
    hitScores: row.hitScores,
    targetType: row.targetType as TargetType | null,
    targetId: row.targetId,
    invocationId: row.invocationId,
    outcome: row.outcome as InvokeOutcome | null,
    tookMs: row.tookMs,
    offeredByOrdinal: row.offeredByOrdinal,
    offeredSearchOrdinal: row.offeredSearchOrdinal,
    offeredRank: row.offeredRank,
    firstSearchRank: row.firstSearchRank,
  };
}

// --- ledger writes -------------------------------------------------------------

export interface WriteTurnPageInput {
  projectId: string;
  turns: readonly TurnDraft[];
  orphanedTurnIds: readonly string[];
  /** The page's last `received_at`, as Postgres text. */
  through: string;
  now: Date;
}

/**
 * Persist one page in one transaction: upsert every re-derived turn by
 * `(project, session, turn_key)`, replace its steps, drop orphaned turns, and advance the
 * cursor. A crash anywhere leaves the page unwritten and the cursor where it was, so the
 * next run redoes exactly this page.
 */
export async function writeTurnPage(
  input: WriteTurnPageInput,
  db: TraceTurnsDb = getDb(),
): Promise<{ turnsWritten: number; stepsWritten: number }> {
  return db.transaction(async (tx) => {
    if (input.orphanedTurnIds.length > 0) {
      for (const ids of chunked(input.orphanedTurnIds, ID_CHUNK)) {
        await tx.delete(traceTurns).where(inArray(traceTurns.id, [...ids]));
      }
    }
    let stepsWritten = 0;
    for (const chunk of chunked(input.turns, TURN_UPSERT_CHUNK)) {
      const written = await tx
        .insert(traceTurns)
        .values(chunk.map((turn) => toTurnRow(input.projectId, turn, input.now)))
        .onConflictDoUpdate({
          target: [traceTurns.projectId, traceTurns.sessionId, traceTurns.turnKey],
          set: {
            sourceId: excluded(traceTurns.sourceId),
            turnSource: excluded(traceTurns.turnSource),
            lane: excluded(traceTurns.lane),
            endUserKey: excluded(traceTurns.endUserKey),
            status: excluded(traceTurns.status),
            endedBy: excluded(traceTurns.endedBy),
            startedAt: excluded(traceTurns.startedAt),
            endedAt: excluded(traceTurns.endedAt),
            lastReceivedAt: excluded(traceTurns.lastReceivedAt),
            searchCount: excluded(traceTurns.searchCount),
            invokeCount: excluded(traceTurns.invokeCount),
            errorCount: excluded(traceTurns.errorCount),
            distinctTools: excluded(traceTurns.distinctTools),
            reSearchCount: excluded(traceTurns.reSearchCount),
            hitsTotal: excluded(traceTurns.hitsTotal),
            abandoned: excluded(traceTurns.abandoned),
            detour: excluded(traceTurns.detour),
            firstTry: excluded(traceTurns.firstTry),
            clockSuspect: excluded(traceTurns.clockSuspect),
            updatedAt: excluded(traceTurns.updatedAt),
          },
        })
        .returning({
          id: traceTurns.id,
          sessionId: traceTurns.sessionId,
          turnKey: traceTurns.turnKey,
        });
      const idByKey = new Map(written.map((w) => [`${w.sessionId}\u0000${w.turnKey}`, w.id]));
      const turnIds = [...idByKey.values()];
      await tx.delete(traceTurnSteps).where(inArray(traceTurnSteps.turnId, turnIds));
      const steps = chunk.flatMap((turn) => {
        const turnId = idByKey.get(`${turn.sessionId}\u0000${turn.turnKey}`);
        if (!turnId) throw new Error("trace turn upsert returned no id for a written turn");
        return turn.steps.map((step) => toStepRow(input.projectId, turnId, step));
      });
      for (const rows of chunked(steps, STEP_INSERT_CHUNK)) {
        await tx.insert(traceTurnSteps).values(rows);
      }
      stepsWritten += steps.length;
    }
    await tx
      .update(projects)
      .set(advanceCursorSet(input.through))
      .where(eq(projects.id, input.projectId));
    return { turnsWritten: input.turns.length, stepsWritten };
  });
}

/** The value the conflicting insert carried for a column. */
function excluded(column: AnyPgColumn): SQL {
  return sql.raw(`excluded."${column.name}"`);
}

function toTurnRow(projectId: string, turn: TurnDraft, now: Date): NewTraceTurnRow {
  return {
    projectId,
    sessionId: turn.sessionId,
    sourceId: turn.sourceId,
    turnKey: turn.turnKey,
    turnSource: turn.turnSource,
    lane: turn.lane,
    endUserKey: turn.endUserKey,
    status: turn.status,
    endedBy: turn.endedBy,
    startedAt: turn.startedAt,
    endedAt: turn.endedAt,
    lastReceivedAt: turn.lastReceivedAt,
    searchCount: turn.searchCount,
    invokeCount: turn.invokeCount,
    errorCount: turn.errorCount,
    distinctTools: turn.distinctTools,
    reSearchCount: turn.reSearchCount,
    hitsTotal: turn.hitsTotal,
    abandoned: turn.abandoned,
    detour: turn.detour,
    firstTry: turn.firstTry,
    clockSuspect: turn.clockSuspect,
    updatedAt: now,
  };
}

function toStepRow(projectId: string, turnId: string, step: StepDraft): NewTraceTurnStepRow {
  return { ...step, projectId, turnId };
}

/** Close open turns whose session has been quiet since `idleBefore`. */
export async function closeIdleTraceTurns(
  projectId: string,
  idleBefore: Date,
  now: Date,
  db: TraceTurnsDb = getDb(),
): Promise<number> {
  const closed = await db
    .update(traceTurns)
    .set({ status: "closed", endedBy: "idle", updatedAt: now })
    .where(
      and(
        eq(traceTurns.projectId, projectId),
        eq(traceTurns.status, "open"),
        sql`${traceTurns.lastReceivedAt} < ${idleBefore}`,
      ),
    )
    .returning({ id: traceTurns.id });
  return closed.length;
}

// --- jobs ------------------------------------------------------------------------

/**
 * What a queued build carries: `reading` asks for a signal run with that trigger once
 * the build has caught up, so the run reads every turn the build wrote rather than
 * racing it (`build-job.ts`).
 */
export interface BuildJobRequest {
  reading?: RunTrigger;
}

/**
 * Enqueue a `build_trace_turns` job, coalesced: the partial unique index
 * `jobs_build_trace_turns_queued_idx` allows one *queued* build per project, so under
 * concurrent ingest the insert no-ops and this returns null. A running build does not
 * block a new queued one, so a batch that lands mid-run still gets a follow-up. A request
 * for a reading is never dropped: it is merged into the queued build when there is one
 * (and that build's id returned).
 */
export async function enqueueBuildTraceTurnsJob(
  projectId: string,
  db: TraceTurnsDb = getDb(),
  request: BuildJobRequest = {},
): Promise<{ id: string } | null> {
  if (!request.reading) {
    const rows = await db
      .insert(jobs)
      .values({ projectId, kind: "build_trace_turns", status: "queued", payload: null })
      .onConflictDoNothing()
      .returning({ id: jobs.id });
    return rows[0] ?? null;
  }
  const payload = { reading: request.reading };
  const rows = await db
    .insert(jobs)
    .values({ projectId, kind: "build_trace_turns", status: "queued", payload })
    .onConflictDoUpdate({
      target: [jobs.projectId, jobs.kind],
      targetWhere: sql`${jobs.status} = 'queued' and ${jobs.kind} = 'build_trace_turns'`,
      set: {
        payload: sql`coalesce(${jobs.payload}, '{}'::jsonb) || ${JSON.stringify(payload)}::jsonb`,
      },
    })
    .returning({ id: jobs.id });
  return rows[0] ?? null;
}

/** The request a build job's payload carries; anything unknown asks for nothing. */
export function parseBuildJobRequest(payload: unknown): BuildJobRequest {
  const reading =
    payload && typeof payload === "object" ? (payload as { reading?: unknown }).reading : undefined;
  return isRunTrigger(reading) ? { reading } : {};
}

/**
 * Turn events received after `since` (the build cursor) and not yet built, counted up to
 * `cap`: the backlog a signal run starting now cannot read. Rides the
 * `(project_id, received_at)` index of turn events.
 */
export async function countUnbuiltTurnEvents(
  projectId: string,
  since: Date | string,
  cap: number,
  db: TraceTurnsDb = getDb(),
): Promise<number> {
  const unbuilt = db
    .select({ one: sql`1` })
    .from(traceEvents)
    .where(
      and(
        eq(traceEvents.projectId, projectId),
        inArray(traceEvents.type, [...TURN_EVENT_TYPES]),
        sql`${traceEvents.receivedAt} > ${cursorValue(since)}`,
      ),
    )
    .limit(cap)
    .as("unbuilt");
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(unbuilt);
  return row?.n ?? 0;
}

export interface DueTraceTurnBuildOptions {
  windowDays?: number;
  errorBackoffMs?: number;
  idleCloseMs?: number;
  limit?: number;
  now?: Date;
}

/**
 * The cron safety net's candidates: projects with turn events past their build cursor
 * (or inside the seed window when it is null), or with open turns gone idle that no build
 * has closed yet. Skips projects with a queued build and those whose last build errored
 * within the backoff. Projects that have built before come first, most behind first.
 */
export async function listProjectsDueTraceTurnBuild(
  db: TraceTurnsDb = getDb(),
  options: DueTraceTurnBuildOptions = {},
): Promise<Array<{ id: string }>> {
  const now = options.now ?? new Date();
  const windowStart = new Date(
    now.getTime() - (options.windowDays ?? TURN_BUILD_SEED_WINDOW_DAYS) * 86_400_000,
  );
  const backoffStart = new Date(
    now.getTime() - (options.errorBackoffMs ?? TURN_BUILD_ERROR_BACKOFF_MS),
  );
  const idleBefore = new Date(now.getTime() - (options.idleCloseMs ?? TURN_IDLE_CLOSE_MS));
  const unbuiltEvents = exists(
    db
      .select({ one: sql`1` })
      .from(traceEvents)
      .where(
        and(
          eq(traceEvents.projectId, projects.id),
          inArray(traceEvents.type, [...TURN_EVENT_TYPES]),
          sql`${traceEvents.receivedAt} > coalesce(${projects.traceTurnsBuiltThrough}, ${windowStart})`,
        ),
      ),
  );
  const idleOpenTurns = exists(
    db
      .select({ one: sql`1` })
      .from(traceTurns)
      .where(
        and(
          eq(traceTurns.projectId, projects.id),
          eq(traceTurns.status, "open"),
          sql`${traceTurns.lastReceivedAt} < ${idleBefore}`,
        ),
      ),
  );
  return db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        or(unbuiltEvents, idleOpenTurns),
        notExists(
          db
            .select({ one: sql`1` })
            .from(jobs)
            .where(
              and(
                eq(jobs.projectId, projects.id),
                eq(jobs.kind, "build_trace_turns"),
                eq(jobs.status, "queued"),
              ),
            ),
        ),
        notExists(
          db
            .select({ one: sql`1` })
            .from(jobs)
            .where(
              and(
                eq(jobs.projectId, projects.id),
                eq(jobs.kind, "build_trace_turns"),
                eq(jobs.status, "error"),
                gt(jobs.finishedAt, backoffStart),
              ),
            ),
        ),
      ),
    )
    .orderBy(sql`${projects.traceTurnsBuiltThrough} asc nulls last`, asc(projects.id))
    .limit(options.limit ?? TURN_BUILD_DUE_LIMIT);
}

function* chunked<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}
