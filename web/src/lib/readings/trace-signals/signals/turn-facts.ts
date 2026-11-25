import { getConfig } from "@/config";
import { searchedAgainForSame, turnDetour } from "@/lib/ledger/same-ask";
import type { StepDraft, TargetType } from "@/lib/ledger/types";
import { CONFIDENT_SCORE_RATIO } from "@/lib/readings/stats";
import {
  afterErrorKinds,
  detectAfterErrors,
} from "@/lib/readings/trace-signals/self-corrections/detect";
import type { SignalTurn } from "@/lib/readings/trace-signals/signals/types";
import type { OtelTurnShapeKind, TurnShapeKind } from "@/lib/readings/trace-signals/view";

/**
 * Per-turn readings shared by the accumulators (signals) and the project
 * metrics (health band, turn shapes), so a "wasted call" or a "detour" means
 * the same thing on every surface.
 */

/** An invocation step with a known target. */
export type InvokeStep = StepDraft & { targetType: TargetType; targetId: string };

export function isInvoke(step: StepDraft): step is InvokeStep {
  return step.kind === "invoke" && step.targetId !== null && step.targetType !== null;
}

/** A search that lists catalog entries (not a gateway search, which carries a count only). */
export function isListingSearch(step: StepDraft): boolean {
  return (
    step.kind === "search" && (step.searchType === "search" || step.searchType === "skill_search")
  );
}

/** The kind of entry a listing search returns. */
export function listedType(step: StepDraft): TargetType {
  return step.searchType === "skill_search" ? "skill" : "tool";
}

/** The accumulators' key for a catalog entry: `tool:<id>` or `skill:<id>`. */
export function entryKey(targetType: TargetType, id: string): string {
  return `${targetType}:${id}`;
}

export function parseEntryKey(key: string): { targetType: TargetType; id: string } {
  const at = key.indexOf(":");
  return { targetType: key.slice(0, at) as TargetType, id: key.slice(at + 1) };
}

/** A signal subject key for an entry: the bare tool id, or `skill:<id>`. */
export function subjectKeyOf(key: string): string {
  const { targetType, id } = parseEntryKey(key);
  return targetType === "tool" ? id : key;
}

/**
 * How close (ms) a call of an entry may start after the previous call of it
 * ended and still be the same round: calls issued together in one model step
 * run back to back with no model round trip between them, while calling a
 * tool again after reading its result takes a model call, seconds at least.
 * Config `traceSignals.fanOutGapMs`, default 250.
 */
export const FAN_OUT_GAP_MS = getConfig().traceSignals.fanOutGapMs;

function endMs(step: StepDraft): number {
  if (step.endOccurredAt) return step.endOccurredAt.getTime();
  return step.occurredAt.getTime() + (step.tookMs ?? 0);
}

/**
 * Rounds of one entry's calls, in step order: a call that starts before the
 * round's last call ended, or within {@link FAN_OUT_GAP_MS} of it, joins that
 * round (a fan-out: one call per worker, per file, per section). A repeat is
 * a later round, never a call inside one.
 */
export function callRounds(calls: readonly StepDraft[], gapMs: number = FAN_OUT_GAP_MS): number {
  let rounds = 0;
  let roundEnd = Number.NEGATIVE_INFINITY;
  for (const call of calls) {
    if (call.occurredAt.getTime() > roundEnd + gapMs) {
      rounds += 1;
      roundEnd = endMs(call);
    } else {
      roundEnd = Math.max(roundEnd, endMs(call));
    }
  }
  return rounds;
}

export interface TurnWaste {
  /** Calls of an entry in a later round (`callRounds`) after an earlier call of it that did not fail. */
  repeats: number;
  /** Retries after an error (`retry_after_error`, `self-corrections/detect.ts`): one per failed call run again. */
  retries: number;
  /** Ok calls followed at once by a search for the same thing (`same-ask.ts`). */
  noFollow: number;
}

/**
 * The wasted calls of one turn, the "Wasted calls" tile's numerator. Retries
 * are the self-corrections module's: every failed call the agent ran again
 * is one, and it is the later call that is wasted, so every other call of an
 * entry it already called is a repeat. Calls issued together in one round
 * (`callRounds`) are a fan-out, not repeats.
 */
export function turnWaste(turn: Pick<SignalTurn, "steps">, withinMs: number): TurnWaste {
  // The end of each entry's current round: a call inside it is a fan-out, not a repeat.
  const roundEnds = new Map<string, number>();
  let again = 0;
  let noFollow = 0;
  turn.steps.forEach((step, index) => {
    if (!isInvoke(step)) return;
    const key = entryKey(step.targetType, step.targetId);
    const roundEnd = roundEnds.get(key);
    if (roundEnd === undefined || step.occurredAt.getTime() > roundEnd + FAN_OUT_GAP_MS) {
      if (roundEnd !== undefined) again += 1;
      roundEnds.set(key, endMs(step));
    } else {
      roundEnds.set(key, Math.max(roundEnd, endMs(step)));
    }
    if (searchedAgainForSame(turn.steps, index, withinMs)) noFollow += 1;
  });
  const retries = detectAfterErrors(turn.steps).filter(
    (event) => event.kind === "retry_after_error",
  ).length;
  return { repeats: Math.max(0, again - retries), retries, noFollow };
}

/**
 * The one shape a closed turn takes, or null when its outcome cannot be
 * measured (an OTLP-lane turn before Phase 1b carries searches only).
 *
 * Precedence, first match wins, so every measurable turn lands in exactly one:
 * 1. `retry`    an entry failed and was run again in the turn (a retry after
 *               an error, `self-corrections/detect.ts`);
 * 2. `repeat`   an entry was run more than once (no failure between);
 * 3. `dead_end` searched and ran nothing;
 * 4. `blind`    ran something without searching;
 * 5. `detour`   searched again for the same thing (a retry, not a new need);
 * 6. `direct`   everything else: searched, ran, done.
 * Waste shapes come first because they are what the page asks the reader to
 * look at; a retry that also detoured reads as a retry.
 */
export function classifyTurnShape(
  turn: Pick<SignalTurn, "steps" | "abandoned">,
): TurnShapeKind | null {
  const invokes = turn.steps.filter(isInvoke);
  const searches = turn.steps.filter((step) => step.kind === "search");
  if (invokes.length === 0) {
    if (turn.abandoned === true) return "dead_end";
    return null;
  }
  const waste = turnWaste(turn, 0);
  if (waste.retries > 0) return "retry";
  if (waste.repeats > 0) return "repeat";
  if (searches.length === 0) return "blind";
  if (turnDetour(turn.steps)) return "detour";
  return "direct";
}

/**
 * Whether a turn is told in the OpenTelemetry vocabulary: an OTLP-lane turn
 * that called a tool and never searched. "Blind" would be wrong there: the
 * customer has no Ratel search step to skip. An OTLP turn that does carry a
 * search (a Ratel search exported over OTel) keeps the SDK vocabulary.
 */
export function usesOtelShapes(turn: Pick<SignalTurn, "steps" | "lane">): boolean {
  return (
    turn.lane === "otlp" &&
    turn.steps.some(isInvoke) &&
    !turn.steps.some((step) => step.kind === "search")
  );
}

/**
 * The shape of an OpenTelemetry turn ({@link usesOtelShapes}), or null for a
 * turn that called nothing. The first three are the self-corrections after a
 * failed call (`self-corrections/detect.ts`); first match wins, so every turn
 * lands in one:
 * 1. `otel_failed`   the last call failed and nothing ran after it (gave up);
 * 2. `otel_switched` a call failed and the next call was a different tool;
 * 3. `otel_retry`    a call failed and the same tool ran again;
 * 4. `otel_chain`    two or more calls, all worked;
 * 5. `otel_direct`   one call that worked.
 * Every failure is covered by the first three: a failed call is the last one,
 * or is followed by the same tool or by a different one. The same tool run
 * twice with nothing failing is a chain: a repeat, not a correction.
 */
export function classifyOtelTurnShape(turn: Pick<SignalTurn, "steps">): OtelTurnShapeKind | null {
  const calls = turn.steps.filter(isInvoke);
  if (calls.length === 0) return null;
  const kinds = afterErrorKinds(turn.steps);
  if (kinds.has("gave_up_after_error")) return "otel_failed";
  if (kinds.has("switch_after_error")) return "otel_switched";
  if (kinds.has("retry_after_error")) return "otel_retry";
  return calls.length > 1 ? "otel_chain" : "otel_direct";
}

/**
 * A listing search's junk estimate: hits scoring below `CONFIDENT_SCORE_RATIO`
 * of the leader. Null when the search carries no usable scores.
 */
export function junkOfSearch(step: StepDraft): { scored: number; junk: number } | null {
  const scores = step.hitScores;
  if (!isListingSearch(step) || !scores || scores.length === 0) return null;
  const top = Math.max(...scores);
  if (!Number.isFinite(top) || top <= 0) return null;
  const junk = scores.filter((score) => score < top * CONFIDENT_SCORE_RATIO).length;
  return { scored: scores.length, junk };
}

/** The UTC day of a turn, `YYYY-MM-DD`. */
export function dayOf(at: Date): string {
  return at.toISOString().slice(0, 10);
}
