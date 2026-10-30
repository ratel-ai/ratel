import type { TURN_EVENT_TYPES } from "@/lib/ledger/constants";

/**
 * Shared shapes of the turn ledger. Three layers:
 *
 * - {@link TurnEventRow} / {@link TurnEventHit}: what the pager reads from
 *   `trace_events` / `trace_event_hits` (and what `replay.ts` adapts a raw dump
 *   into). Raw query text and end-user ids exist only here and are hashed away
 *   by `normalize`.
 * - {@link NormalizedEvent}: one turn-relevant event, text-free, times as epoch
 *   ms. The segmenter's input, and what a stored step turns back into.
 * - {@link TurnDraft} / {@link StepDraft}: the builder's output, column for
 *   column the `trace_turns` / `trace_turn_steps` rows minus ids, so detectors
 *   read a replay's in-memory turns and the stored ledger the same way.
 */

export type TurnEventType = (typeof TURN_EVENT_TYPES)[number];
export type TurnLane = "runtime" | "otlp";
export type TurnSource = "declared" | "inferred" | "otlp";
export type TurnStatus = "open" | "closed";
export type TurnEndedBy = "next_turn" | "gap" | "cap" | "idle";
export type StepKind = "search" | "invoke";
export type SearchType = "search" | "skill_search" | "gateway_search";
export type TargetType = "tool" | "skill";
export type InvokeOutcome = "ok" | "error" | "unknown";

/** One `trace_events` row as the builder reads it. */
export interface TurnEventRow {
  id: string;
  type: string;
  sessionId: string | null;
  sourceId: string | null;
  /** "runtime" | "otlp" | null (rows ingested before provenance existed). */
  ingestSource: string | null;
  occurredAt: Date | null;
  receivedAt: Date;
  /** The envelope's host-declared `turn_id`, or null. */
  turnId: string | null;
  invocationId: string | null;
  traceId: string | null;
  toolId: string | null;
  skillId: string | null;
  /** Raw user text: hashed by `normalize`, never stored or logged. */
  query: string | null;
  topK: number | null;
  hitCount: number | null;
  tookMs: number | null;
  /** Raw end-user id: hashed by `normalize`, never stored or logged. */
  endUserId: string | null;
  /**
   * OTLP lane only: the tool call is the root span of its trace, so the trace
   * holds no other call (an MCP server without propagated context). Absent on
   * every other row.
   */
  rootTool?: boolean;
}

/** One `trace_event_hits` row; `rank` is 0-based as stored. */
export interface TurnEventHit {
  rank: number;
  targetType: string;
  targetId: string;
  score: number | null;
}

/**
 * How an event takes part in a turn: a search, the start of an invocation, the
 * end or error closing one, or a complete invocation in one event
 * (`skill_invoke`, `gateway_invoke`, `gateway_error`).
 */
export type EventRole = "search" | "start" | "end" | "single";

export interface NormalizedEvent {
  id: string;
  type: TurnEventType;
  role: EventRole;
  lane: TurnLane;
  sessionId: string;
  sourceId: string | null;
  /** Epoch ms; the event's own time, falling back to receipt. */
  occurredAt: number;
  /** Epoch ms of receipt. */
  receivedAt: number;
  declaredTurnId: string | null;
  traceId: string | null;
  endUserKey: string | null;
  // Search events:
  queryHash: string | null;
  topK: number | null;
  hitCount: number | null;
  /** At most `MAX_STEP_HIT_IDS`, rank order; empty for a gateway search. */
  hitIds: readonly string[];
  /** Parallel to `hitIds`, or null when any score is missing. */
  hitScores: readonly number[] | null;
  // Invocation events:
  targetType: TargetType | null;
  targetId: string | null;
  invocationId: string | null;
  tookMs: number | null;
  /** For an end or single event: ok, or error for the error variants. */
  outcome: Exclude<InvokeOutcome, "unknown"> | null;
  /** See {@link TurnEventRow.rootTool}. */
  rootTool?: boolean;
}

/** How an invocation start found its end. */
export type PairingMethod = "invocation_id" | "fallback";

export interface InvocationPair {
  endId: string;
  method: PairingMethod;
}

/** The segmenter's output: one turn's events in timeline order. */
export interface SegmentedTurn {
  lane: TurnLane;
  sessionId: string;
  turnKey: string;
  turnSource: TurnSource;
  events: readonly NormalizedEvent[];
  /** start id -> the end it paired with. */
  pairs: ReadonlyMap<string, InvocationPair>;
  status: TurnStatus;
  endedBy: TurnEndedBy | null;
  clockSuspect: boolean;
}

/** One `trace_turn_steps` row minus ids. Times are Dates, as in the table. */
export interface StepDraft {
  ordinal: number;
  kind: StepKind;
  eventType: TurnEventType;
  traceEventId: string;
  endTraceEventId: string | null;
  declared: boolean;
  occurredAt: Date;
  receivedAt: Date;
  endOccurredAt: Date | null;
  endReceivedAt: Date | null;
  gapMs: number | null;
  searchOrdinal: number | null;
  searchType: SearchType | null;
  queryHash: string | null;
  topK: number | null;
  hitCount: number | null;
  hitIds: string[] | null;
  hitScores: number[] | null;
  targetType: TargetType | null;
  targetId: string | null;
  invocationId: string | null;
  outcome: InvokeOutcome | null;
  tookMs: number | null;
  offeredByOrdinal: number | null;
  offeredSearchOrdinal: number | null;
  offeredRank: number | null;
  firstSearchRank: number | null;
}

/** The turn-level facts `aggregate` derives from a turn's steps. */
export interface TurnFacts {
  searchCount: number;
  invokeCount: number;
  errorCount: number;
  distinctTools: number;
  reSearchCount: number;
  hitsTotal: number;
  abandoned: boolean | null;
  detour: boolean;
  firstTry: boolean | null;
  clockSuspect: boolean;
}

/** One `trace_turns` row minus ids, with its steps. */
export interface TurnDraft extends TurnFacts {
  sessionId: string;
  sourceId: string | null;
  turnKey: string;
  turnSource: TurnSource;
  lane: TurnLane;
  endUserKey: string | null;
  status: TurnStatus;
  endedBy: TurnEndedBy | null;
  startedAt: Date;
  endedAt: Date;
  lastReceivedAt: Date;
  steps: StepDraft[];
}

/** A turn read back from the ledger for re-derivation. */
export interface StoredTurn {
  id: string;
  sessionId: string;
  sourceId: string | null;
  turnKey: string;
  turnSource: TurnSource;
  lane: TurnLane;
  endUserKey: string | null;
  steps: readonly StepDraft[];
}
