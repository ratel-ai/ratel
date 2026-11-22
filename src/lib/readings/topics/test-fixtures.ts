import type { StepDraft } from "@/lib/ledger/types";
import { tokenize } from "@/lib/readings/text/cluster";
import type { DistinctAsk, TopicTurn } from "@/lib/readings/topics/asks";
import { hashText, normalizeAsk } from "@/lib/readings/trace-signals/workflows/decide";

/** Test fixtures for topics: turns, asks and steps in a few words. */

export const T0 = Date.parse("2026-10-01T09:00:00Z");
const MINUTE = 60_000;

let counter = 0;

export function turn(over: Partial<TopicTurn> & { at?: number; minutes?: number } = {}): TopicTurn {
  counter += 1;
  const start = over.startedAt?.getTime() ?? over.at ?? T0 + counter * MINUTE;
  const { at: _at, minutes, ...rest } = over;
  return {
    id: `turn-${counter}`,
    sessionId: "s1",
    endUserKey: null,
    turnSource: "declared",
    startedAt: new Date(start),
    endedAt: new Date(start + (minutes ?? 0.5) * MINUTE),
    endedBy: "next_turn",
    calls: [{ tool: "lookup", outcome: "ok" }],
    firstSearch: null,
    workflowId: null,
    ...rest,
  };
}

export function ask(text: string, turns: number | string[] = 1, user = true): DistinctAsk {
  const key = normalizeAsk(text);
  const turnIds = Array.isArray(turns)
    ? turns
    : Array.from({ length: turns }, (_, i) => `${key}-${i}`);
  return { key, hash: hashText(key), text, turnIds, user, tokens: new Set(tokenize(key)) };
}

export function searchStep(queryHash: string | null, hitIds: string[] | null = null): StepDraft {
  const at = new Date(T0);
  return {
    ordinal: 1,
    kind: "search",
    eventType: "search",
    traceEventId: `e-${queryHash ?? "x"}`,
    endTraceEventId: null,
    declared: false,
    occurredAt: at,
    receivedAt: at,
    endOccurredAt: null,
    endReceivedAt: null,
    gapMs: null,
    searchOrdinal: 1,
    searchType: "search",
    queryHash,
    topK: 10,
    hitCount: hitIds?.length ?? 0,
    hitIds,
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
