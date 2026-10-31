import type {
  NormalizedEvent,
  PairingMethod,
  SearchType,
  SegmentedTurn,
  StepDraft,
  TargetType,
} from "@/lib/ledger/types";

/**
 * Invocation pairing and search attribution: one segmented turn -> its steps.
 *
 * Pairing (boundary rule 7): an invocation's end or error pairs with its start
 * by `invocation_id`; without one, with the earliest still-open start of the
 * same tool at most `pairingWindowMs` older. The segmenter runs the matcher
 * while it walks the timeline (so an end lands in its start's turn) and hands
 * the result over in `SegmentedTurn.pairs`; this module only reads it. A start
 * that never paired is outcome `unknown`; an end that never paired stands alone.
 *
 * Attribution: an invocation's `offered_*` come from the latest earlier search
 * in the turn whose hits list its target; `first_search_rank` from the turn's
 * first search. Ranks are 1-based, like the "#7" the page prints.
 */

/** A start still waiting for its end, as the segmenter tracks it. */
export interface PendingStart {
  event: NormalizedEvent;
  /** Index of the turn it belongs to, opaque to the matcher. */
  turn: number;
}

/**
 * The pending start `end` closes, or null. `pending` is in arrival order, so the
 * fallback picks the oldest open start of the tool (first in, first out).
 */
export function matchPendingStart(
  end: NormalizedEvent,
  pending: readonly PendingStart[],
  pairingWindowMs: number,
): { index: number; method: PairingMethod } | null {
  if (end.invocationId) {
    const index = pending.findIndex((p) => p.event.invocationId === end.invocationId);
    if (index >= 0) return { index, method: "invocation_id" };
  }
  const index = pending.findIndex(
    (p) =>
      p.event.targetType === end.targetType &&
      p.event.targetId === end.targetId &&
      // Two different declared ids are two different calls.
      !(p.event.invocationId && end.invocationId && p.event.invocationId !== end.invocationId) &&
      end.occurredAt - p.event.occurredAt <= pairingWindowMs,
  );
  return index >= 0 ? { index, method: "fallback" } : null;
}

/** Build a turn's steps: one per search, and one per invocation (start + end
 * merged). Step order is the turn's event order. */
export function attributeTurn(turn: SegmentedTurn): StepDraft[] {
  const ends = endsById(turn);
  const paired = new Set<string>();
  for (const pair of turn.pairs.values()) paired.add(pair.endId);

  const steps: StepDraft[] = [];
  let searchOrdinal = 0;
  for (const event of turn.events) {
    if (event.role === "end" && paired.has(event.id)) continue;
    const previous = steps[steps.length - 1];
    const gapMs = previous ? Math.max(0, event.occurredAt - previous.occurredAt.getTime()) : null;
    if (event.role === "search") {
      searchOrdinal += 1;
      steps.push(searchStep(event, steps.length + 1, searchOrdinal, gapMs));
    } else {
      const pair = event.role === "start" ? turn.pairs.get(event.id) : undefined;
      const end = pair ? (ends.get(pair.endId) ?? null) : null;
      steps.push(invokeStep(event, end, steps.length + 1, gapMs, steps));
    }
  }
  return steps;
}

function endsById(turn: SegmentedTurn): Map<string, NormalizedEvent> {
  const out = new Map<string, NormalizedEvent>();
  for (const event of turn.events) if (event.role === "end") out.set(event.id, event);
  return out;
}

function searchStep(
  event: NormalizedEvent,
  ordinal: number,
  searchOrdinal: number,
  gapMs: number | null,
): StepDraft {
  return {
    ...emptyStep(event, ordinal, gapMs),
    kind: "search",
    searchOrdinal,
    searchType: event.type as SearchType,
    queryHash: event.queryHash,
    topK: event.topK,
    hitCount: event.hitCount,
    hitIds: [...event.hitIds],
    hitScores: event.hitScores ? [...event.hitScores] : null,
  };
}

function invokeStep(
  event: NormalizedEvent,
  end: NormalizedEvent | null,
  ordinal: number,
  gapMs: number | null,
  earlier: readonly StepDraft[],
): StepDraft {
  const offered = latestOffering(earlier, event.targetType, event.targetId);
  return {
    ...emptyStep(event, ordinal, gapMs),
    kind: "invoke",
    endTraceEventId: end?.id ?? null,
    endOccurredAt: end ? new Date(end.occurredAt) : null,
    endReceivedAt: end ? new Date(end.receivedAt) : null,
    targetType: event.targetType,
    targetId: event.targetId,
    invocationId: event.invocationId ?? end?.invocationId ?? null,
    outcome: event.role === "start" ? (end?.outcome ?? "unknown") : event.outcome,
    tookMs: event.role === "start" ? tookFromEnd(event, end) : event.tookMs,
    offeredByOrdinal: offered?.step.ordinal ?? null,
    offeredSearchOrdinal: offered?.step.searchOrdinal ?? null,
    offeredRank: offered?.rank ?? null,
    firstSearchRank: firstSearchRank(earlier, event.targetType, event.targetId),
  };
}

function tookFromEnd(start: NormalizedEvent, end: NormalizedEvent | null): number | null {
  if (!end) return null;
  return end.tookMs ?? Math.max(0, end.occurredAt - start.occurredAt);
}

/** The latest earlier search listing the target, and the 1-based rank it had. */
function latestOffering(
  earlier: readonly StepDraft[],
  targetType: TargetType | null,
  targetId: string | null,
): { step: StepDraft; rank: number } | null {
  if (!targetType || !targetId) return null;
  for (let i = earlier.length - 1; i >= 0; i--) {
    const rank = rankIn(earlier[i], targetType, targetId);
    if (rank !== null) return { step: earlier[i], rank };
  }
  return null;
}

function firstSearchRank(
  earlier: readonly StepDraft[],
  targetType: TargetType | null,
  targetId: string | null,
): number | null {
  if (!targetType || !targetId) return null;
  const first = earlier.find((s) => s.searchOrdinal === 1);
  return first ? rankIn(first, targetType, targetId) : null;
}

/** 1-based rank of the target in a search step's hits, or null. */
export function rankIn(step: StepDraft, targetType: TargetType, targetId: string): number | null {
  if (step.kind !== "search" || !step.hitIds) return null;
  if (targetTypeOf(step.searchType) !== targetType) return null;
  const index = step.hitIds.indexOf(targetId);
  return index >= 0 ? index + 1 : null;
}

function targetTypeOf(searchType: SearchType | null): TargetType | null {
  if (searchType === "search") return "tool";
  if (searchType === "skill_search") return "skill";
  return null;
}

function emptyStep(event: NormalizedEvent, ordinal: number, gapMs: number | null): StepDraft {
  return {
    ordinal,
    kind: "search",
    eventType: event.type,
    traceEventId: event.id,
    endTraceEventId: null,
    declared: event.declaredTurnId !== null,
    occurredAt: new Date(event.occurredAt),
    receivedAt: new Date(event.receivedAt),
    endOccurredAt: null,
    endReceivedAt: null,
    gapMs,
    searchOrdinal: null,
    searchType: null,
    queryHash: null,
    topK: null,
    hitCount: null,
    hitIds: null,
    hitScores: null,
    targetType: null,
    targetId: null,
    invocationId: null,
    outcome: null,
    tookMs: null,
    offeredByOrdinal: null,
    offeredSearchOrdinal: null,
    offeredRank: null,
    firstSearchRank: null,
  };
}
