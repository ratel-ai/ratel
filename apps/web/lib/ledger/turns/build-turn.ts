import { DEFAULT_TURN_CONFIG, type TurnConfig } from "@/lib/ledger/constants";
import { aggregateTurn } from "@/lib/ledger/turns/aggregate";
import { attributeTurn } from "@/lib/ledger/turns/attribute";
import { OTLP_RUN_PREFIX, segmentEvents } from "@/lib/ledger/turns/segment";
import type {
  NormalizedEvent,
  SearchType,
  SegmentedTurn,
  StepDraft,
  StoredTurn,
  TurnDraft,
  TurnEventType,
} from "@/lib/ledger/types";

/**
 * The pure core of the build job: stored turns (open, idle-closed, named by a
 * declared turn id in the page, or within the page's {@link reloadReach}) plus
 * a page of new events -> the turns to write. Stored steps are turned back into the events they came from and
 * re-segmented with the new ones, so
 *
 *   build(all events) == closed turns of build(batch 1) + build(open turns of batch 1, batch 2)
 *
 * which is what lets the job advance its cursor page by page and still write
 * the ledger a single full pass would. Idempotent: rebuilding from a turn's own
 * steps with no new events reproduces it.
 *
 * `orphanedTurnIds` lists stored turns whose key the rebuild no longer produced.
 * Keys are stable by construction, so it is empty in practice; the writer
 * deletes them so a surprise can never leave a stale duplicate behind.
 */

export interface BuildTurnsInput {
  stored: readonly StoredTurn[];
  events: readonly NormalizedEvent[];
  now: Date;
  config?: TurnConfig;
}

export interface BuildTurnsResult {
  turns: TurnDraft[];
  orphanedTurnIds: string[];
}

export function buildTurns(input: BuildTurnsInput): BuildTurnsResult {
  const config = input.config ?? DEFAULT_TURN_CONFIG;
  const byId = new Map<string, NormalizedEvent>();
  for (const turn of input.stored) {
    for (const event of storedTurnEvents(turn)) byId.set(event.id, event);
  }
  for (const event of input.events) if (!byId.has(event.id)) byId.set(event.id, event);

  const turns = segmentEvents([...byId.values()], input.now, config).map(draftTurn);
  const produced = new Set(turns.map((t) => `${t.sessionId}\u0000${t.turnKey}`));
  const orphanedTurnIds = input.stored
    .filter((t) => !produced.has(`${t.sessionId}\u0000${t.turnKey}`))
    .map((t) => t.id);
  return { turns, orphanedTurnIds };
}

/**
 * How far a page of new events reaches back into stored turns that are already
 * closed, so the loader can hand them to {@link buildTurns} again:
 *
 * - an end in the page pairs with a start at most `pairingWindowMs` older, so a
 *   session holding a still-unpaired `invoke_start` at or after `pairingFloor`
 *   reloads that turn and every turn after it (all ended at or after the floor);
 * - a gateway row in the page is dropped against a native row at most
 *   `gatewayDedupeMs` away (and a stored gateway row against a native row in the
 *   page), so every turn that ended at or after `gatewayFloor` is reloaded.
 *
 * Without this an end whose start's turn had already closed (by gap, cap or the
 * next turn) would land as a phantom invocation in whatever turn is open, and a
 * gateway row would be counted beside the native row it restates. Reloading a
 * suffix of the session (everything that ended after the floor) keeps the
 * rebuilt turns' close reasons the ones a full pass derives. Null for an empty
 * page.
 */
export interface ReloadReach {
  pairingFloor: Date;
  gatewayFloor: Date;
}

export function reloadReach(
  events: readonly NormalizedEvent[],
  config: TurnConfig = DEFAULT_TURN_CONFIG,
): ReloadReach | null {
  if (events.length === 0) return null;
  const earliest = events.reduce((min, e) => Math.min(min, e.occurredAt), Infinity);
  return {
    pairingFloor: new Date(earliest - config.pairingWindowMs),
    gatewayFloor: new Date(earliest - config.gatewayDedupeMs),
  };
}

/** One segmented turn -> its steps and facts, ready to write. */
export function draftTurn(turn: SegmentedTurn): TurnDraft {
  const steps = attributeTurn(turn);
  const facts = aggregateTurn(steps, turn.lane, turn.clockSuspect);
  const first = turn.events[0];
  const times = turn.events.map((e) => e.occurredAt);
  return {
    sessionId: turn.sessionId,
    sourceId: turn.events.find((e) => e.sourceId !== null)?.sourceId ?? null,
    turnKey: turn.turnKey,
    turnSource: turn.turnSource,
    lane: turn.lane,
    endUserKey: turn.events.find((e) => e.endUserKey !== null)?.endUserKey ?? null,
    status: turn.status,
    endedBy: turn.endedBy,
    startedAt: new Date(first.occurredAt),
    endedAt: new Date(times.reduce((max, t) => Math.max(max, t), first.occurredAt)),
    lastReceivedAt: new Date(turn.events.reduce((max, e) => Math.max(max, e.receivedAt), 0)),
    ...facts,
    steps,
  };
}

/**
 * A stored turn's steps as the events they were built from. Turn-level fields
 * (source, end user, OTLP trace id) ride on every event; a declared step gets
 * its turn id back from the key. An invocation step yields its start (or
 * single event) and, when it paired, its end.
 */
export function storedTurnEvents(turn: StoredTurn): NormalizedEvent[] {
  const declaredTurnId = turn.turnKey.startsWith("declared:")
    ? turn.turnKey.slice("declared:".length)
    : null;
  const traceId = turn.turnKey.startsWith("otlp:") ? turn.turnKey.slice("otlp:".length) : null;
  // A run of root-tool calls holds nothing else, so every event gets the mark back.
  const rootTool = turn.turnKey.startsWith(OTLP_RUN_PREFIX);
  const base = (step: StepDraft) => ({
    lane: turn.lane,
    sessionId: turn.sessionId,
    sourceId: turn.sourceId,
    declaredTurnId: step.declared ? declaredTurnId : null,
    traceId,
    endUserKey: turn.endUserKey,
    ...(rootTool ? { rootTool: true } : {}),
  });
  return turn.steps.flatMap((step): NormalizedEvent[] =>
    step.kind === "search" ? [searchEvent(step, base(step))] : invokeEvents(step, base(step)),
  );
}

type EventBase = Pick<
  NormalizedEvent,
  "lane" | "sessionId" | "sourceId" | "declaredTurnId" | "traceId" | "endUserKey" | "rootTool"
>;

const NO_SEARCH = {
  queryHash: null,
  topK: null,
  hitCount: null,
  hitIds: [] as string[],
  hitScores: null,
} as const;

function searchEvent(step: StepDraft, base: EventBase): NormalizedEvent {
  return {
    ...base,
    id: step.traceEventId,
    type: (step.searchType ?? step.eventType) as SearchType,
    role: "search",
    occurredAt: step.occurredAt.getTime(),
    receivedAt: step.receivedAt.getTime(),
    queryHash: step.queryHash,
    topK: step.topK,
    hitCount: step.hitCount,
    hitIds: step.hitIds ?? [],
    hitScores: step.hitScores,
    targetType: null,
    targetId: null,
    invocationId: null,
    tookMs: null,
    outcome: null,
  };
}

function invokeEvents(step: StepDraft, base: EventBase): NormalizedEvent[] {
  const target = {
    targetType: step.targetType,
    targetId: step.targetId,
    invocationId: step.invocationId,
  };
  if (step.eventType !== "invoke_start") {
    const role =
      step.eventType === "invoke_end" || step.eventType === "invoke_error" ? "end" : "single";
    return [
      {
        ...base,
        ...NO_SEARCH,
        ...target,
        id: step.traceEventId,
        type: step.eventType,
        role,
        occurredAt: step.occurredAt.getTime(),
        receivedAt: step.receivedAt.getTime(),
        tookMs: step.tookMs,
        outcome: step.outcome === "error" ? "error" : "ok",
      },
    ];
  }
  const start: NormalizedEvent = {
    ...base,
    ...NO_SEARCH,
    ...target,
    id: step.traceEventId,
    type: "invoke_start",
    role: "start",
    occurredAt: step.occurredAt.getTime(),
    receivedAt: step.receivedAt.getTime(),
    tookMs: null,
    outcome: null,
  };
  if (!step.endTraceEventId || !step.endOccurredAt || !step.endReceivedAt) return [start];
  const endType: TurnEventType = step.outcome === "error" ? "invoke_error" : "invoke_end";
  return [
    start,
    {
      ...base,
      ...NO_SEARCH,
      ...target,
      // The end rides with its start; a declared start had a declared end.
      id: step.endTraceEventId,
      type: endType,
      role: "end",
      occurredAt: step.endOccurredAt.getTime(),
      receivedAt: step.endReceivedAt.getTime(),
      tookMs: step.tookMs,
      outcome: step.outcome === "error" ? "error" : "ok",
    },
  ];
}
