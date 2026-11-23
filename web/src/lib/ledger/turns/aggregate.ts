import { turnDetour, turnFirstTry } from "@/lib/ledger/same-ask";
import type { StepDraft, TurnFacts, TurnLane } from "@/lib/ledger/types";

/**
 * A turn's facts, from its steps. The definitions the hero band and the
 * detectors build on:
 *
 * - `reSearchCount`: searches that come after an invocation in the same turn
 *   (the agent ran something, then went looking again).
 * - `detour`: the turn searched again for the same thing (`same-ask.ts`): a
 *   search repeating the ask of the one before it. A later search for a new
 *   need is a next step, not a detour.
 * - `firstTry`: every invoked target was offered by the most recent search
 *   before its first call, and that search was not a retry. Null when the turn
 *   has no search or no invocation with a target.
 * - `abandoned`: searched and never invoked. Null on the OTLP lane, whose rows
 *   carry searches only until Phase 1b joins its tool spans.
 * - `hitsTotal`: the sum of each search's hit count (a gateway search's count
 *   included), not the capped id lists.
 */
export function aggregateTurn(
  steps: readonly StepDraft[],
  lane: TurnLane,
  clockSuspect: boolean,
): TurnFacts {
  const searches = steps.filter((s) => s.kind === "search");
  const invokes = steps.filter((s) => s.kind === "invoke");
  const targeted = invokes.filter((s) => s.targetId !== null);
  const firstInvoke = invokes[0]?.ordinal ?? Number.POSITIVE_INFINITY;

  return {
    searchCount: searches.length,
    invokeCount: invokes.length,
    errorCount: invokes.filter((s) => s.outcome === "error").length,
    distinctTools: new Set(targeted.map((s) => `${s.targetType}:${s.targetId}`)).size,
    reSearchCount: searches.filter((s) => s.ordinal > firstInvoke).length,
    hitsTotal: searches.reduce((sum, s) => sum + (s.hitCount ?? s.hitIds?.length ?? 0), 0),
    abandoned: lane === "otlp" ? null : searches.length > 0 && invokes.length === 0,
    detour: turnDetour(steps),
    firstTry: turnFirstTry(steps),
    clockSuspect,
  };
}
