import { and, asc, desc, eq, gt, inArray, lt, or } from "drizzle-orm";
import { traceEvents } from "@/lib/ingest/trace-events/schema";
import { traceTurnSteps, traceTurns } from "@/lib/ledger/schema";
import type { TurnSource } from "@/lib/ledger/types";
import { getDb } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import { reportServerException } from "@/lib/platform/telemetry";
import type { StoryQuery } from "@/lib/readings/trace-signals/view";
import { otelTraceSummaries } from "@/lib/synthesis/traces/schema";
import { loadTurnLinked, type TurnLinked } from "@/lib/views/traces/turn-detail-linked";

/**
 * One turn as Traces shows it: every call it made, in order, from the turn
 * ledger, with what only the live `trace_events` rows know (query text, error
 * text, trace ids) read by id. This is what an Agent health example links to,
 * because it resolves for every turn the ledger kept: declared, inferred or
 * OTLP, with or without a trace id. Runtime events rarely carry a trace, so the
 * trace waterfall alone would leave most examples with nowhere to go.
 *
 * A pruned event (30 days) reads `expired`, never blank. A trace id is only
 * offered as a link when Traces actually holds that trace.
 */

export type TurnDetailDb = Pick<ReturnType<typeof getDb>, "select">;

/** How many of a search's listed hits the page prints. */
export const TURN_DETAIL_HITS = 10;

export interface TurnDetailHit {
  /** 1-based. */
  rank: number;
  id: string;
  score: number | null;
}

export interface TurnDetailCall {
  ordinal: number;
  kind: "search" | "invoke";
  /** The wire type of the step's event: `search`, `gateway_invoke`, `invoke_start`, ... */
  eventType: string;
  /** `trace_events.id` of the step (for a call, its start). */
  eventId: string;
  occurredAt: string;
  /** Since the previous call; null for the first. */
  gapMs: number | null;
  /* Search: */
  query: StoryQuery | null;
  hitCount: number | null;
  hits: readonly TurnDetailHit[];
  /* Call: */
  targetType: "tool" | "skill" | null;
  targetId: string | null;
  outcome: "ok" | "error" | "unknown" | null;
  tookMs: number | null;
  /** 1-based rank it held in the search that offered it. */
  offeredRank: number | null;
  errorMessage: string | null;
  /** Set only when Traces holds this trace, so the link never lands on nothing. */
  traceId: string | null;
  spanId: string | null;
}

export interface TurnDetail {
  id: string;
  sessionId: string;
  turnSource: TurnSource;
  lane: string;
  status: string;
  startedAt: string;
  endedAt: string;
  calls: readonly TurnDetailCall[];
  /** The turns just before and after it in the same session. */
  previousTurnId: string | null;
  nextTurnId: string | null;
  /** An SDK run's linked OpenTelemetry model calls and the user's ask (`turn-detail-linked.ts`); absent otherwise. */
  linked?: TurnLinked;
}

export interface TurnHeadRow {
  id: string;
  sessionId: string;
  turnSource: string;
  lane: string;
  status: string;
  startedAt: Date;
  endedAt: Date;
}

export interface TurnStepRow {
  ordinal: number;
  kind: string;
  eventType: string;
  traceEventId: string;
  endTraceEventId: string | null;
  occurredAt: Date;
  gapMs: number | null;
  hitCount: number | null;
  hitIds: string[] | null;
  hitScores: number[] | null;
  targetType: string | null;
  targetId: string | null;
  outcome: string | null;
  tookMs: number | null;
  offeredRank: number | null;
}

export interface LiveTurnEvent {
  query: string | null;
  errorMessage: string | null;
  traceId: string | null;
  spanId: string | null;
}

const ID_CHUNK = 500;
const logger = getLogger("trace-signals/turn-detail");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The page for one turn, or null when the id is not a turn of this project. */
export async function loadTurnDetail(
  projectId: string,
  turnId: string,
  db: TurnDetailDb = getDb(),
): Promise<TurnDetail | null> {
  if (!UUID.test(turnId)) return null;
  const [head] = await db
    .select({
      id: traceTurns.id,
      sessionId: traceTurns.sessionId,
      turnSource: traceTurns.turnSource,
      lane: traceTurns.lane,
      status: traceTurns.status,
      startedAt: traceTurns.startedAt,
      endedAt: traceTurns.endedAt,
    })
    .from(traceTurns)
    .where(and(eq(traceTurns.projectId, projectId), eq(traceTurns.id, turnId)))
    .limit(1);
  if (!head) return null;

  const steps = await db
    .select({
      ordinal: traceTurnSteps.ordinal,
      kind: traceTurnSteps.kind,
      eventType: traceTurnSteps.eventType,
      traceEventId: traceTurnSteps.traceEventId,
      endTraceEventId: traceTurnSteps.endTraceEventId,
      occurredAt: traceTurnSteps.occurredAt,
      gapMs: traceTurnSteps.gapMs,
      hitCount: traceTurnSteps.hitCount,
      hitIds: traceTurnSteps.hitIds,
      hitScores: traceTurnSteps.hitScores,
      targetType: traceTurnSteps.targetType,
      targetId: traceTurnSteps.targetId,
      outcome: traceTurnSteps.outcome,
      tookMs: traceTurnSteps.tookMs,
      offeredRank: traceTurnSteps.offeredRank,
    })
    .from(traceTurnSteps)
    .where(and(eq(traceTurnSteps.projectId, projectId), eq(traceTurnSteps.turnId, head.id)))
    .orderBy(asc(traceTurnSteps.ordinal));

  const eventIds = [
    ...new Set(
      steps.flatMap((s) =>
        s.endTraceEventId ? [s.traceEventId, s.endTraceEventId] : [s.traceEventId],
      ),
    ),
  ];
  const events = await loadLiveTurnEvents(projectId, eventIds, db);
  const traces = await loadKnownTraces(
    projectId,
    [...new Set([...events.values()].flatMap((e) => (e.traceId ? [e.traceId] : [])))],
    db,
  );
  const [previousTurnId, nextTurnId] = await loadNeighbours(projectId, head, db);
  const detail = toTurnDetail(head, steps, events, traces, { previousTurnId, nextTurnId });
  const linked = await linkedOf(projectId, head, detail, db);
  return linked ? { ...detail, linked } : detail;
}

/** Best-effort: the linked model calls are extra, so a failed read leaves the page as it was. */
async function linkedOf(
  projectId: string,
  head: TurnHeadRow,
  detail: TurnDetail,
  db: TurnDetailDb,
): Promise<TurnLinked | null> {
  const searched =
    detail.calls.flatMap((call) =>
      call.query?.state === "captured" ? [call.query.text] : [],
    )[0] ?? null;
  try {
    return await loadTurnLinked(projectId, head, searched, db);
  } catch (err) {
    logger.error(
      { err, project_id: projectId, turn_id: head.id },
      "linked model calls unreadable for turn detail",
    );
    reportServerException(err, `project:${projectId}`, {
      operation: "turn_detail_linked_model_calls",
    });
    return null;
  }
}

/** Pure: the ledger rows and live events as the page reads them. */
export function toTurnDetail(
  head: TurnHeadRow,
  steps: readonly TurnStepRow[],
  events: ReadonlyMap<string, LiveTurnEvent>,
  knownTraces: ReadonlySet<string>,
  neighbours: { previousTurnId: string | null; nextTurnId: string | null },
): TurnDetail {
  return {
    id: head.id,
    sessionId: head.sessionId,
    turnSource: head.turnSource as TurnSource,
    lane: head.lane,
    status: head.status,
    startedAt: head.startedAt.toISOString(),
    endedAt: head.endedAt.toISOString(),
    calls: steps.map((step) => toCall(step, events, knownTraces)),
    ...neighbours,
  };
}

function toCall(
  step: TurnStepRow,
  events: ReadonlyMap<string, LiveTurnEvent>,
  knownTraces: ReadonlySet<string>,
): TurnDetailCall {
  const start = events.get(step.traceEventId);
  const end = step.endTraceEventId ? events.get(step.endTraceEventId) : undefined;
  const search = step.kind === "search";
  // The start and the end of a call can each carry the trace; either will do.
  const traced = [start, end].find((e) => e?.traceId && knownTraces.has(e.traceId)) ?? null;
  return {
    ordinal: step.ordinal,
    kind: search ? "search" : "invoke",
    eventType: step.eventType,
    eventId: step.traceEventId,
    occurredAt: step.occurredAt.toISOString(),
    gapMs: step.gapMs,
    query: search ? queryOf(start) : null,
    hitCount: search ? (step.hitCount ?? step.hitIds?.length ?? null) : null,
    hits: search ? hitsOf(step) : [],
    targetType: step.targetType === "tool" || step.targetType === "skill" ? step.targetType : null,
    targetId: step.targetId,
    outcome: search ? null : outcomeOf(step.outcome),
    tookMs: step.tookMs,
    offeredRank: step.offeredRank,
    errorMessage: search ? null : (end?.errorMessage ?? start?.errorMessage ?? null),
    traceId: traced?.traceId ?? null,
    spanId: traced?.spanId ?? null,
  };
}

function queryOf(event: LiveTurnEvent | undefined): StoryQuery {
  if (!event) return { state: "expired" };
  const text = event.query?.trim();
  return text ? { state: "captured", text } : { state: "not_captured" };
}

function hitsOf(step: TurnStepRow): TurnDetailHit[] {
  return (step.hitIds ?? []).slice(0, TURN_DETAIL_HITS).map((id, index) => ({
    rank: index + 1,
    id,
    score: step.hitScores?.[index] ?? null,
  }));
}

function outcomeOf(value: string | null): "ok" | "error" | "unknown" {
  return value === "ok" || value === "error" ? value : "unknown";
}

async function loadLiveTurnEvents(
  projectId: string,
  eventIds: readonly string[],
  db: TurnDetailDb,
): Promise<Map<string, LiveTurnEvent>> {
  const out = new Map<string, LiveTurnEvent>();
  for (let i = 0; i < eventIds.length; i += ID_CHUNK) {
    const rows = await db
      .select({
        id: traceEvents.id,
        query: traceEvents.query,
        errorMessage: traceEvents.errorMessage,
        traceId: traceEvents.traceId,
        spanId: traceEvents.spanId,
      })
      .from(traceEvents)
      .where(
        and(
          eq(traceEvents.projectId, projectId),
          inArray(traceEvents.id, eventIds.slice(i, i + ID_CHUNK)),
        ),
      );
    for (const { id, ...event } of rows) out.set(id, event);
  }
  return out;
}

/** The trace ids Traces can open for this project. */
async function loadKnownTraces(
  projectId: string,
  traceIds: readonly string[],
  db: TurnDetailDb,
): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < traceIds.length; i += ID_CHUNK) {
    const rows = await db
      .select({ traceId: otelTraceSummaries.traceId })
      .from(otelTraceSummaries)
      .where(
        and(
          eq(otelTraceSummaries.projectId, projectId),
          inArray(otelTraceSummaries.traceId, traceIds.slice(i, i + ID_CHUNK)),
        ),
      );
    for (const row of rows) out.add(row.traceId);
  }
  return out;
}

async function loadNeighbours(
  projectId: string,
  head: TurnHeadRow,
  db: TurnDetailDb,
): Promise<[string | null, string | null]> {
  const session = and(
    eq(traceTurns.projectId, projectId),
    eq(traceTurns.sessionId, head.sessionId),
  );
  const [before] = await db
    .select({ id: traceTurns.id })
    .from(traceTurns)
    .where(
      and(
        session,
        or(
          lt(traceTurns.startedAt, head.startedAt),
          and(eq(traceTurns.startedAt, head.startedAt), lt(traceTurns.id, head.id)),
        ),
      ),
    )
    .orderBy(desc(traceTurns.startedAt), desc(traceTurns.id))
    .limit(1);
  const [after] = await db
    .select({ id: traceTurns.id })
    .from(traceTurns)
    .where(
      and(
        session,
        or(
          gt(traceTurns.startedAt, head.startedAt),
          and(eq(traceTurns.startedAt, head.startedAt), gt(traceTurns.id, head.id)),
        ),
      ),
    )
    .orderBy(asc(traceTurns.startedAt), asc(traceTurns.id))
    .limit(1);
  return [before?.id ?? null, after?.id ?? null];
}
