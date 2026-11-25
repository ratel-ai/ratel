import type { StepDraft } from "@/lib/ledger/types";
import {
  FAILURE_FOLLOWED,
  type FailureFollowed,
} from "@/lib/readings/trace-signals/outcomes/kinds";
import {
  detectAfterErrors,
  type SelfCorrection,
  type SelfCorrectionKind,
} from "@/lib/readings/trace-signals/self-corrections/detect";
import { type StepCall, stepCalls } from "@/lib/readings/trace-signals/step-calls";

/**
 * What followed a failure, per failure streak of one turn. Pure.
 *
 * A streak is consecutive failed calls of one tool: searches between them do
 * not break it, a call of another tool or a call that did not fail does. Three
 * failed tries of one call are one failure the agent was stuck on, not three.
 *
 * What followed is read at the streak's last failed call, from the one
 * definition of a retry, a switch and a give-up (`detectAfterErrors`,
 * `self-corrections/detect.ts`), so this and the self-corrections agree:
 *
 * - `fixed_next_try`: the very next step is the same tool, and it worked.
 * - `fixed_after_detour`: the same tool worked later in the turn, after a
 *   search or another call in between.
 * - `switched_tool`: the next call is a different tool and the failed tool
 *   never worked again in the turn. Whether the other tool worked is
 *   `recovered`.
 * - `nothing_followed`: no call ran after it (`gave_up_after_error`; a search
 *   after it is not a run), or only calls of the same tool whose end was never
 *   seen.
 *
 * A call whose end was never seen (`unknown`) is neither a failure nor a fix.
 */

export interface FailureStreak {
  /** The tool that failed, as a node id (a skill as `skill:<id>`). */
  tool: string;
  /** 1-based ordinals, in the turn, of the streak's failed calls, in order. */
  ordinals: number[];
  followed: FailureFollowed;
  /** A later call in the turn succeeded, of any tool. */
  recovered: boolean;
}

type Call = StepCall;

/** Maximal runs of consecutive failed calls of one tool, as index ranges into `calls`. */
function streakRanges(calls: readonly Call[]): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  for (let i = 0; i < calls.length; i++) {
    if (calls[i]!.step.outcome !== "error") continue;
    const from = i;
    while (
      i + 1 < calls.length &&
      calls[i + 1]!.step.outcome === "error" &&
      calls[i + 1]!.node === calls[from]!.node
    )
      i++;
    ranges.push({ from, to: i });
  }
  return ranges;
}

function followedOf(
  steps: readonly StepDraft[],
  calls: readonly Call[],
  last: number,
  kinds: ReadonlySet<SelfCorrectionKind>,
): FailureFollowed {
  if (kinds.has("gave_up_after_error")) return "nothing_followed";
  const failed = calls[last]!;
  const fix = kinds.has("retry_after_error")
    ? calls.slice(last + 1).find((call) => call.node === failed.node && call.step.outcome === "ok")
    : undefined;
  if (fix) {
    const next = steps.find((step) => step.ordinal > failed.step.ordinal);
    return next === fix.step ? "fixed_next_try" : "fixed_after_detour";
  }
  return kinds.has("switch_after_error") ? "switched_tool" : "nothing_followed";
}

/** The failure streaks of one turn, from its steps in ordinal order. */
export function failureStreaks(steps: readonly StepDraft[]): FailureStreak[] {
  const calls = stepCalls(steps);
  const events = new Map<number, SelfCorrection[]>();
  for (const event of detectAfterErrors(steps)) {
    if (event.toolOrdinal === null) continue;
    events.set(event.toolOrdinal, [...(events.get(event.toolOrdinal) ?? []), event]);
  }
  return streakRanges(calls).map(({ from, to }) => {
    const after = events.get(calls[to]!.step.ordinal) ?? [];
    return {
      tool: calls[from]!.node,
      ordinals: calls.slice(from, to + 1).map((call) => call.step.ordinal),
      followed: followedOf(steps, calls, to, new Set(after.map((event) => event.kind))),
      recovered: after.some((event) => event.recovered === true),
    };
  });
}

const FOLLOWED_RANK: ReadonlyMap<FailureFollowed, number> = new Map(
  FAILURE_FOLLOWED.map((followed, i) => [followed, i]),
);

/**
 * The turn's leading failure: the streak that ended worst (nothing followed,
 * then a switch, then a fix after a detour, then a fix on the next try), the
 * earliest on a tie. It is what the turn's own `followed` and `cause` say.
 * Null when no call failed.
 */
export function leadingStreak<T extends Pick<FailureStreak, "followed">>(
  streaks: readonly T[],
): T | null {
  let leading: T | null = null;
  for (const streak of streaks) {
    if (
      !leading ||
      (FOLLOWED_RANK.get(streak.followed) ?? 0) > (FOLLOWED_RANK.get(leading.followed) ?? 0)
    )
      leading = streak;
  }
  return leading;
}
