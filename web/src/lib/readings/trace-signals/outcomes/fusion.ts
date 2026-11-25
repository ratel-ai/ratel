import {
  BLOCKING_CAUSES,
  type FusionSource,
  type ModelCause,
  NEGATIVE_REACTIONS,
  type Reaction,
  type SessionOutcome,
  type StoredFailureStreak,
  type TurnResult,
} from "@/lib/readings/trace-signals/outcomes/kinds";
import { satisfactionOf, type TurnAnswers } from "@/lib/readings/trace-signals/outcomes/questions";
import { leftOpen, searchedOnly } from "@/lib/readings/trace-signals/outcomes/read";

/**
 * The fusion: what a turn came to and what a session came to, decided in
 * code from the rule facts and the model's closed answers. No call is made
 * here. Pure.
 *
 * TURN RESULT, first match wins:
 * 1. `refused`: the cause is a correct refusal. The agent was right not to
 *    do it, so the turn is neither a failure nor a completion.
 * 2. `failed`: the trace ended in an error (a failure streak nothing
 *    recovered from, or a request no call worked for), unless the person's
 *    next message is satisfied and the model does not say the work was left
 *    undone: an error in a turn that still gave the person what they wanted.
 *    A reply cannot overrule the trace: a turn whose reply says done over
 *    such an error is a FALSE COMPLETION, and it failed.
 * 3. `failed`: the model says the agent did not complete what was asked.
 * 4. `completed_wrong`: the work ran and was wrong: the agent misunderstood,
 *    or the person's next message objects to it. A changed mind ("actually,
 *    let's use Redis") is a new request, not a correction, whatever else is
 *    read into it.
 * 5. `completed`: a call worked, or an answer says so.
 * Otherwise nothing is known and the turn has no result.
 *
 * With the rules alone a result is `failed` or `completed` and its source is
 * `rule`: the trace says whether the calls worked, not whether they were the
 * right ones.
 *
 * SESSION OUTCOME, from its turns in order:
 * - With any answer about the person's text (`model`): `escalated` when the
 *   person asked for a human; else, when the last turn left them without
 *   what they asked for, `blocked` if the agent could not do it (no access,
 *   no tool, a rule) and `gave_up` otherwise; else `resolved_after_friction`
 *   when a turn on the way failed, went wrong or was objected to, and
 *   `resolved_clean` when none did. A correct refusal on the way is not
 *   friction.
 * - With the rules alone (`rule`): only the classes the trace can support
 *   (`RULE_SESSION_OUTCOMES`). `blocked` or `gave_up` when the last request
 *   was left open, by the same test; else resolved, after friction when a
 *   call failed or no tool fit a search on the way. Never `escalated`.
 * - Turns that only searched (`searchedOnly`) say nothing: a session of
 *   nothing else has no outcome.
 */

/** The rule facts of a turn the fusion reads. */
export interface FusionTurnFacts {
  okCalls: number;
  failedCalls: number;
  unmetSearches: number;
  failures: readonly Pick<StoredFailureStreak, "followed" | "recovered">[];
}

export interface FusedTurn {
  /** Null when nothing is known: no call ended and nothing was answered. */
  result: TurnResult | null;
  source: FusionSource | null;
  /** The reply says the work is done while the trace ended in an error. */
  falseCompletion: boolean;
  /** A cause the fusion itself finds (`false_success`); written only where the rules left the cause open. */
  cause: ModelCause | null;
}

/** The turn's trace ended in an error: a failure nothing recovered from, or a request no call worked for. */
export function traceFailed(facts: FusionTurnFacts): boolean {
  const unrecovered = facts.failures.some(
    (streak) =>
      streak.followed === "nothing_followed" ||
      (streak.followed === "switched_tool" && !streak.recovered),
  );
  return unrecovered || leftOpen(facts);
}

/**
 * Whether the person's next message objects to the turn. A plain new request
 * or a changed mind does not, even when it does not sound satisfied.
 */
export function objectedTo(answers: Pick<TurnAnswers, "satisfied" | "reaction">): boolean {
  if (answers.reaction === "new_request") return false;
  return satisfactionOf(answers) === "unsatisfied";
}

/**
 * Whether an answer about the person's text bears on the turn's result. The
 * request gate and the search-run question do not: one says what the message
 * is, the other reads the agent's own queries.
 */
const readText = (answers: TurnAnswers): boolean =>
  answers.satisfied !== null ||
  answers.reaction !== null ||
  answers.misunderstood !== null ||
  answers.completed !== null ||
  answers.claims !== null ||
  answers.cause !== null;

/** One turn's result from its rule facts and its answers (`NO_ANSWERS` when the model layer did not read it). */
export function turnResult(facts: FusionTurnFacts, answers: TurnAnswers): FusedTurn {
  const failedTrace = traceFailed(facts);
  const falseCompletion = failedTrace && answers.claims === "yes";
  const cause = falseCompletion ? ("false_success" as const) : null;
  if (!readText(answers)) {
    const result = failedTrace ? "failed" : facts.okCalls > 0 ? "completed" : null;
    return { result, source: result ? "rule" : null, falseCompletion: false, cause: null };
  }
  const done = (result: TurnResult): FusedTurn => ({
    result,
    source: "model",
    falseCompletion,
    cause,
  });
  if (answers.cause === "correct_refusal")
    return { result: "refused", source: "model", falseCompletion: false, cause: null };
  const satisfied = satisfactionOf(answers) === "satisfied";
  if (failedTrace && !(satisfied && answers.completed !== "no" && !falseCompletion))
    return done("failed");
  if (answers.completed === "no") return done("failed");
  if (answers.misunderstood === "yes" || objectedTo(answers)) return done("completed_wrong");
  if (
    facts.okCalls > 0 ||
    answers.completed === "yes" ||
    satisfied ||
    satisfactionOf(answers) === "neutral"
  )
    return done("completed");
  return { result: null, source: null, falseCompletion: false, cause: null };
}

/** One turn as the session's outcome reads it: what its row keeps. */
export interface FusionSessionTurn {
  okCalls: number;
  failedCalls: number;
  /** Failure streaks in the turn. */
  streaks: number;
  unmetSearches: number;
  result?: string | null;
  resultSource?: string | null;
  satisfaction?: string | null;
  reaction?: string | null;
  cause?: string | null;
  searches?: number;
  calls?: number;
  request?: boolean | null;
}

export interface FusedSession {
  outcome: SessionOutcome;
  source: FusionSource;
}

const isNegative = (reaction: string | null | undefined): boolean =>
  (NEGATIVE_REACTIONS as readonly string[]).includes(reaction ?? "");
const objected = (turn: FusionSessionTurn): boolean =>
  turn.reaction !== "new_request" &&
  (turn.satisfaction === "unsatisfied" || isNegative(turn.reaction));
const wentWrong = (turn: FusionSessionTurn): boolean =>
  turn.result === "failed" || turn.result === "completed_wrong";

/** The agent could not do it at all: a correct refusal, no access, no tool for it. */
function blocked(turn: FusionSessionTurn): boolean {
  if (turn.result === "refused") return true;
  if ((BLOCKING_CAUSES as readonly string[]).includes(turn.cause ?? "")) return true;
  // A search no listed tool fits, with no failed call: a missing tool.
  return turn.failedCalls === 0 && turn.unmetSearches > 0 && turn.okCalls === 0;
}

/** Whether a model's answer is part of what the session's rows say. */
const readByModel = (turn: FusionSessionTurn): boolean =>
  turn.resultSource === "model" ||
  (turn.satisfaction ?? null) !== null ||
  (turn.reaction ?? null) !== null;

/** One session's outcome from its turns, oldest first; null when it has none but searches. */
export function sessionOutcome(all: readonly FusionSessionTurn[]): FusedSession | null {
  const turns = all.filter((turn) => !searchedOnly(turn));
  const last = turns.at(-1);
  if (!last) return null;
  if (!turns.some(readByModel)) {
    // The trace alone: was the last request left open, and did anything fail on the way.
    if (leftOpen(last)) return { outcome: blocked(last) ? "blocked" : "gave_up", source: "rule" };
    const friction = turns.some((turn) => turn.streaks > 0 || turn.unmetSearches > 0);
    return { outcome: friction ? "resolved_after_friction" : "resolved_clean", source: "rule" };
  }
  if (turns.some((turn) => turn.reaction === ("asks_human" satisfies Reaction)))
    return { outcome: "escalated", source: "model" };
  const walkedAway =
    last.reaction === ("gives_up" satisfies Reaction) ||
    last.reaction === ("takes_over" satisfies Reaction);
  const unresolved =
    last.result === "refused" ||
    wentWrong(last) ||
    walkedAway ||
    objected(last) ||
    ((last.result ?? null) === null && leftOpen(last));
  if (unresolved) return { outcome: blocked(last) ? "blocked" : "gave_up", source: "model" };
  // A correct refusal on the way is not friction: the agent was right.
  const friction = turns.some((turn) => wentWrong(turn) || objected(turn));
  return { outcome: friction ? "resolved_after_friction" : "resolved_clean", source: "model" };
}

/** A false completion read back from a stored row: the reply said done and the turn failed. */
export const isFalseCompletion = (row: {
  claimedDone: boolean | null;
  result: string | null;
}): boolean => row.claimedDone === true && row.result === "failed";
