import { type OtelFacts, otelTraceIdOf } from "@/lib/readings/trace-signals/signals/otel-facts";
import {
  classifyOtelTurnShape,
  isInvoke,
  turnWaste,
} from "@/lib/readings/trace-signals/signals/turn-facts";
import type { SignalTurn } from "@/lib/readings/trace-signals/signals/types";
import { OTEL_TURN_SHAPE_KINDS, type OtelTurnShapeKind } from "@/lib/readings/trace-signals/view";

/**
 * The daily counts behind the OpenTelemetry band and shapes, kept beside a
 * day's SDK counts (`DayBucket.otel`) and only on days that had such turns,
 * so an SDK project's stored buckets are exactly what they were. A turn
 * counts here when it is told in the OpenTelemetry vocabulary
 * (`usesOtelShapes`): an OTLP-lane turn that called a tool and never searched.
 * Counts only; no ids, no text.
 */

export type OtelShapeCounts = Record<OtelTurnShapeKind, number>;

export interface OtelDay {
  /** Runs that called a tool. */
  turns: number;
  /** ...whose last call did not fail. */
  completed: number;
  calls: number;
  failedCalls: number;
  /** Repeats and retries of the same tool (the "Wasted calls" tile). */
  wasted: number;
  /** Runs whose model calls were sent, and how many model calls they made. */
  roundTripTurns: number;
  roundTrips: number;
  shapes: OtelShapeCounts;
  /** Runs whose tool results were captured (content capture on). */
  resultTurns: number;
  /** Runs whose model calls carried the tool menu (tool definitions on). */
  menuTurns: number;
  /** Runs that carried a conversation id of their own, not just the trace id. */
  sessionTurns: number;
}

/** What OpenTelemetry recorded about one turn beyond its steps. */
export interface OtelTurnExtras {
  /** Model calls in the turn's trace; null when none were sent. */
  roundTrips: number | null;
  resultsCaptured: boolean;
  menuCaptured: boolean;
  hasSession: boolean;
}

export const NO_OTEL_EXTRAS: OtelTurnExtras = Object.freeze({
  roundTrips: null,
  resultsCaptured: false,
  menuCaptured: false,
  hasSession: false,
});

export function emptyOtelShapes(): OtelShapeCounts {
  return { otel_direct: 0, otel_chain: 0, otel_retry: 0, otel_switched: 0, otel_failed: 0 };
}

export function emptyOtelDay(): OtelDay {
  return {
    turns: 0,
    completed: 0,
    calls: 0,
    failedCalls: 0,
    wasted: 0,
    roundTripTurns: 0,
    roundTrips: 0,
    shapes: emptyOtelShapes(),
    resultTurns: 0,
    menuTurns: 0,
    sessionTurns: 0,
  };
}

/** The extras of one turn, read from the facts ingest recorded beside the ledger. */
export function otelTurnExtras(
  turn: Pick<SignalTurn, "steps" | "lane" | "turnKey" | "sessionId">,
  facts: OtelFacts | null,
): OtelTurnExtras {
  const traceId = otelTraceIdOf(turn);
  const hasSession = traceId !== null && turn.sessionId !== traceId;
  if (!facts) return { ...NO_OTEL_EXTRAS, hasSession };
  const trace = traceId ? facts.traces.get(traceId) : undefined;
  const resultsCaptured = turn.steps
    .filter(isInvoke)
    .some((step) => (facts.stepFacts.get(step.traceEventId)?.resultEmpty ?? null) !== null);
  return {
    roundTrips: trace && trace.modelCalls > 0 ? trace.modelCalls : null,
    resultsCaptured,
    menuCaptured: (trace?.menuCalls ?? 0) > 0,
    hasSession,
  };
}

/** One turn's contribution, for a turn told in the OpenTelemetry vocabulary. */
export function otelDayOf(
  turn: Pick<SignalTurn, "steps">,
  extras: OtelTurnExtras = NO_OTEL_EXTRAS,
): OtelDay {
  const calls = turn.steps.filter(isInvoke);
  const shape = classifyOtelTurnShape(turn);
  const waste = turnWaste(turn, 0);
  const failed = calls.filter((call) => call.outcome === "error").length;
  const lastFailed = calls.at(-1)?.outcome === "error";
  return {
    turns: 1,
    completed: lastFailed ? 0 : 1,
    calls: calls.length,
    failedCalls: failed,
    wasted: waste.repeats + waste.retries,
    roundTripTurns: extras.roundTrips === null ? 0 : 1,
    roundTrips: extras.roundTrips ?? 0,
    shapes: shape === null ? emptyOtelShapes() : { ...emptyOtelShapes(), [shape]: 1 },
    resultTurns: extras.resultsCaptured ? 1 : 0,
    menuTurns: extras.menuCaptured ? 1 : 0,
    sessionTurns: extras.hasSession ? 1 : 0,
  };
}

/** Two days added together; absent on both sides stays absent. */
export function addOtelDays(
  left: OtelDay | undefined,
  right: OtelDay | undefined,
): OtelDay | undefined {
  if (!left) return right ? { ...right, shapes: { ...right.shapes } } : undefined;
  if (!right) return { ...left, shapes: { ...left.shapes } };
  const shapes = Object.fromEntries(
    OTEL_TURN_SHAPE_KINDS.map((kind) => [
      kind,
      (left.shapes[kind] ?? 0) + (right.shapes[kind] ?? 0),
    ]),
  ) as OtelShapeCounts;
  return {
    turns: left.turns + right.turns,
    completed: left.completed + right.completed,
    calls: left.calls + right.calls,
    failedCalls: left.failedCalls + right.failedCalls,
    wasted: left.wasted + right.wasted,
    roundTripTurns: left.roundTripTurns + right.roundTripTurns,
    roundTrips: left.roundTrips + right.roundTrips,
    shapes,
    resultTurns: left.resultTurns + right.resultTurns,
    menuTurns: left.menuTurns + right.menuTurns,
    sessionTurns: left.sessionTurns + right.sessionTurns,
  };
}
