import type { InvokeOutcome, StepDraft, TargetType, TurnSource } from "@/lib/ledger/types";
import type { SignalTurn } from "@/lib/readings/trace-signals/signals/types";

/**
 * Small, fast turn builders for the workflow tests: closed `SignalTurn`s with
 * tool calls only, built directly (no ledger pipeline), so a 20k-turn
 * performance check builds in milliseconds.
 *
 *   wfTurn(["find", { tool: "assign", outcome: "error", tookMs: 900 }], { durationMs: 4_000 })
 */

const T0 = Date.parse("2026-09-01T09:00:00Z");
let serial = 0;

export interface CallSpec {
  tool: string;
  outcome?: InvokeOutcome;
  tookMs?: number | null;
  targetType?: TargetType;
}

export type Call = string | CallSpec;

export interface WfTurnOptions {
  id?: string;
  durationMs?: number;
  /** Start time offset from a fixed base, in ms. Defaults to the turn's serial. */
  startMs?: number;
  turnSource?: TurnSource;
}

function step(call: Call, ordinal: number, at: Date, turnId: string): StepDraft {
  const spec: CallSpec = typeof call === "string" ? { tool: call } : call;
  return {
    ordinal,
    kind: "invoke",
    eventType: "invoke_start",
    traceEventId: `${turnId}-e${ordinal}`,
    endTraceEventId: null,
    declared: false,
    occurredAt: at,
    receivedAt: at,
    endOccurredAt: null,
    endReceivedAt: null,
    gapMs: null,
    searchOrdinal: null,
    searchType: null,
    queryHash: null,
    topK: null,
    hitCount: null,
    hitIds: null,
    hitScores: null,
    targetType: spec.targetType ?? "tool",
    targetId: spec.tool,
    invocationId: null,
    outcome: spec.outcome ?? "ok",
    tookMs: spec.tookMs === undefined ? 100 : spec.tookMs,
    offeredByOrdinal: null,
    offeredSearchOrdinal: null,
    offeredRank: null,
    firstSearchRank: null,
  };
}

/** One closed turn whose steps are the given tool calls, in order. */
export function wfTurn(calls: readonly Call[], opts: WfTurnOptions = {}): SignalTurn {
  serial += 1;
  const id = opts.id ?? `wf-${serial.toString().padStart(7, "0")}`;
  const start = T0 + (opts.startMs ?? serial * 1_000);
  const duration = opts.durationMs ?? 2_000;
  const gap = calls.length > 0 ? duration / calls.length : 0;
  return {
    id,
    sessionId: `s-${id}`,
    turnSource: opts.turnSource ?? "inferred",
    lane: opts.turnSource === "otlp" ? "otlp" : "runtime",
    startedAt: new Date(start),
    endedAt: new Date(start + duration),
    searchCount: 0,
    invokeCount: calls.length,
    errorCount: calls.filter((c) => typeof c !== "string" && c.outcome === "error").length,
    reSearchCount: 0,
    abandoned: null,
    detour: false,
    firstTry: null,
    steps: calls.map((call, i) => step(call, i, new Date(start + i * gap), id)),
  };
}

/** `n` turns of `make(i)`. */
export function many(n: number, make: (i: number) => SignalTurn): SignalTurn[] {
  return Array.from({ length: n }, (_, i) => make(i));
}

/** A deterministic PRNG in [0, 1) (mulberry32), for the larger fixtures. */
export function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export const byIdMap = (turns: readonly SignalTurn[]): Map<string, SignalTurn> =>
  new Map(turns.map((t) => [t.id, t]));
