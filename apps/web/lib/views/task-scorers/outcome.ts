import type { StepDraft } from "@/lib/ledger/types";
import { detectAfterErrors } from "@/lib/readings/trace-signals/self-corrections/detect";
import type {
  Outcome,
  OutcomeDefaults,
  OutcomeRun,
  ScorerRun,
} from "@/lib/views/task-scorers/types";

/**
 * How a run ended, read the way the rest of the product reads it (RC-61): the
 * outcome checks the fix doesn't set directly. Pure.
 *
 * Self-corrections are Self-corrections' own definition (`detectAfterErrors`:
 * retries, switches and give-ups after a failed call). A run ends well when it
 * ran a tool or answered, and its last call didn't fail: the
 * `gave_up_after_error` rule.
 */

const EPOCH = new Date(0);

/** Derive outcome thresholds from a recording. Keep a quarter of room for cost and latency. */
export function outcomeDefaults(run: OutcomeRun): OutcomeDefaults {
  const recorded = run.steps.filter((step) => step.kind === "invoke");
  const corrections = selfCorrectionsOf({
    calls: recorded.map((call) => call.targetId),
    outcomes: recorded.map((call) => call.outcome),
  });
  return {
    endsWell: true,
    maxSelfCorrections: corrections,
    maxCostUsd: costLimit(run.costUsd),
    maxLatencyMs: latencyLimit(run.durationMs),
  };
}

/** A cost limit: the measured cost with room, rounded up to four places. Null when unmeasured. */
export function costLimit(costUsd: number | null | undefined): number | null {
  const cost = withRoom(costUsd);
  return cost === null ? null : Math.ceil(cost * 10_000) / 10_000;
}

/** A time limit: the measured time with room, rounded up to the millisecond. Null when unmeasured. */
export function latencyLimit(latencyMs: number | null | undefined): number | null {
  const latency = withRoom(latencyMs);
  return latency === null ? null : Math.ceil(latency);
}

/** Retries, switches and give-ups after a failed call; null when the side's calls or their outcomes are unknown. */
export function selfCorrectionsOf(view: Pick<ScorerRun, "calls" | "outcomes">): number | null {
  if (!view.calls || !view.outcomes || view.outcomes.length !== view.calls.length) return null;
  return detectAfterErrors(asSteps(view.calls, view.outcomes)).length;
}

/**
 * Whether the run ended well: it didn't end on a failed call, and it ran a
 * tool or answered. Null when the side's calls or outcomes are unknown.
 */
export function endsWellOf(
  view: Pick<ScorerRun, "calls" | "outcomes" | "answered">,
): boolean | null {
  if (!view.calls || !view.outcomes || view.outcomes.length !== view.calls.length) return null;
  const last = view.outcomes[view.outcomes.length - 1];
  if (last === "error") return false;
  if (view.calls.length > 0) return view.answered !== false;
  return view.answered ?? null;
}

/** A recorded number with room: "no worse than recorded, give or take a quarter". Null stays null. */
export function withRoom(value: number | null | undefined, factor = 1.25): number | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return null;
  return value * factor;
}

/** The calls as the self-correction detector reads steps: only kind, target and outcome matter to it. */
function asSteps(calls: readonly string[], outcomes: readonly Outcome[]): StepDraft[] {
  return calls.map((targetId, index) => ({
    ordinal: index + 1,
    kind: "invoke",
    eventType: "invoke_start",
    traceEventId: `call-${index}`,
    endTraceEventId: null,
    declared: false,
    occurredAt: EPOCH,
    receivedAt: EPOCH,
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
    targetType: "tool",
    targetId,
    invocationId: null,
    outcome: outcomes[index] ?? "unknown",
    tookMs: null,
    offeredByOrdinal: null,
    offeredSearchOrdinal: null,
    offeredRank: null,
    firstSearchRank: null,
  }));
}
