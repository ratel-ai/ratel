import type {
  FrictionReason,
  GoalSource,
  TaskReason,
  TaskResult,
  TaskTier,
  TurnCause,
} from "@/lib/readings/trace-signals/outcomes/kinds";
import { leftOpen } from "@/lib/readings/trace-signals/outcomes/read";

/**
 * TASKS: a session cut into goals and the work after each, and what each task
 * came to. Pure: stored turn rows in, task drafts out; no text, no call.
 *
 * SEGMENTATION. A task starts at a turn that states a goal and takes every
 * turn after it until the next one:
 *   - a turn whose message the model read as a request (`request = true`);
 *   - a turn whose message is not a request (`request = false`: "thanks",
 *     "no, the other one", "again please") never starts one: it belongs to
 *     the task before it;
 *   - without the person's words (`request` null), every turn is its own
 *     task: its goal is the agent's own tool search when the turn has one,
 *     else there is none.
 * So the same rule cuts a chat with messages, a trace-only agent behind the
 * search gateway, and a trace-only agent with no searches.
 *
 * RESULT, first match wins (`taskOutcome`):
 *   1. not completed: the person asked for a human, gave up or took over, on
 *      any turn of the task (escalated, gave_up, took_over);
 *   2. not completed, refused: the last turn was a correct refusal;
 *   3. not completed: the last turn got no successful call (failed_call, or
 *      no_tool when it ended on a search with nothing run);
 *   4. not completed: the last turn failed or did the wrong thing by the
 *      fusion of its answers (`trace_turn_outcomes.result`), or the person's
 *      next message objected to it (wrong_action, failed_call, unsatisfied);
 *   5. the model's answer about the whole task, when it was asked: not
 *      achieved (goal_missed), partly (did_part); unsure or can't tell is
 *      `unknown`;
 *   6. completed after friction: a call failed, a search met nothing, or a
 *      turn was objected to on the way;
 *   7. completed: a call worked, or a model said the work was done;
 *   8. otherwise `unknown`: nothing worked and nothing failed.
 * The person's words outrank the model, and the model outranks a trace that
 * only shows calls working.
 */

/** One stored turn row as the task fold reads it. */
export interface TaskTurn {
  turnId: string;
  startedAt: Date;
  endedAt: Date;
  okCalls: number;
  failedCalls: number;
  /** Failure streaks in the turn. */
  streaks: number;
  unmetSearches: number;
  /** The fused result of the turn (`TURN_RESULTS`), when there is one. */
  result?: string | null;
  resultSource?: string | null;
  satisfaction?: string | null;
  reaction?: string | null;
  cause?: string | null;
  /** The model read the person's message as a request (true), not one (false), or did not read it (null). */
  request?: boolean | null;
  /** The turn ran at least one search. */
  searches?: number;
  /** How the person took the turn as the agent's next reply shows it, where their own message was not read. */
  replyReaction?: string | null;
}

export interface TaskDraft {
  /** The first turn's id: the task's key. */
  taskId: string;
  turnIds: string[];
  startedAt: Date;
  endedAt: Date;
  goalSource: GoalSource;
}

/** The model's answer about a whole task: did its work achieve its goal. */
export const TASK_ANSWERS = ["achieved", "partly", "not_achieved", "cant_tell"] as const;

export type TaskAnswer = (typeof TASK_ANSWERS)[number];

/** Below this, an answer of the task question reads as "can't tell". */
export const TASK_ANSWER_MIN_PROBABILITY = 0.8;

export interface TaskVerdict {
  answer: TaskAnswer | "unknown";
  probability: number | null;
}

export interface TaskOutcome {
  result: TaskResult;
  /** Why it was not completed, or, completed after friction, what got in its way. */
  reason: TaskReason | FrictionReason | null;
  /** The turn cause behind the reason, when one is known (`bad_arguments`, `misread_request`…). */
  cause: string | null;
  /** The goal was checked: by the model's task answer, or by answers about the person's words. */
  checked: boolean;
  tier: TaskTier;
  source: "rule" | "model";
}

const byStart = (a: TaskTurn, b: TaskTurn): number =>
  a.startedAt.getTime() - b.startedAt.getTime() ||
  (a.turnId < b.turnId ? -1 : a.turnId > b.turnId ? 1 : 0);

/** A session's turns cut into tasks, in order. */
export function segmentTasks(turns: readonly TaskTurn[]): Array<TaskDraft & { turns: TaskTurn[] }> {
  const ordered = [...turns].sort(byStart);
  const out: Array<TaskDraft & { turns: TaskTurn[] }> = [];
  for (const turn of ordered) {
    const current = out.at(-1);
    // A message the model read as not a request belongs to the task before it.
    if (current && turn.request === false) {
      current.turns.push(turn);
      current.turnIds.push(turn.turnId);
      current.endedAt = turn.endedAt;
      continue;
    }
    const goalSource: GoalSource =
      turn.request === true
        ? "request"
        : turn.request === false
          ? "request"
          : (turn.searches ?? 0) > 0
            ? "search"
            : "none";
    out.push({
      taskId: turn.turnId,
      turnIds: [turn.turnId],
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
      goalSource,
      turns: [turn],
    });
  }
  return out;
}

/** How the person took the turn: their own words, else what the agent's next reply shows. */
const reactionOf = (turn: TaskTurn): string | null => turn.reaction ?? turn.replyReaction ?? null;

const objected = (turn: TaskTurn): boolean =>
  reactionOf(turn) !== "new_request" &&
  (turn.satisfaction === "unsatisfied" || ["corrects", "repeats"].includes(reactionOf(turn) ?? ""));

/** How much the task could be read from. */
export function tierOf(goalSource: GoalSource, turns: readonly TaskTurn[]): TaskTier {
  const inferred = turns.some((turn) => (turn.replyReaction ?? null) !== null);
  if (goalSource === "none") return inferred ? "tr" : "t0";
  if (goalSource === "search") return inferred ? "tr" : "t1";
  return turns.some(
    (turn) => (turn.satisfaction ?? null) !== null || (turn.reaction ?? null) !== null,
  )
    ? "t3"
    : "t2";
}

/** What a task came to, from its turns (in order) and, when it was asked, the model's answer about the whole task. */
export function taskOutcome(
  task: Pick<TaskDraft, "goalSource">,
  turns: readonly TaskTurn[],
  verdict: TaskVerdict | null,
): TaskOutcome {
  const ordered = [...turns].sort(byStart);
  const last = ordered.at(-1);
  const tier = tierOf(task.goalSource, ordered);
  const textRead = ordered.some(
    (turn) =>
      turn.resultSource === "model" ||
      (turn.satisfaction ?? null) !== null ||
      reactionOf(turn) !== null,
  );
  const asked = verdict !== null && verdict.answer !== "unknown";
  const source: TaskOutcome["source"] = textRead || asked ? "model" : "rule";
  const checked = textRead || asked;
  const no = (reason: TaskReason, cause: string | null = null): TaskOutcome => ({
    result: "not_completed",
    reason,
    cause,
    checked,
    tier,
    source,
  });
  if (!last) return { result: "unknown", reason: null, cause: null, checked: false, tier, source };

  // 1. The person walked away, on any turn of the task.
  if (ordered.some((turn) => reactionOf(turn) === "asks_human")) return no("escalated");
  if (reactionOf(last) === "gives_up") return no("gave_up");
  if (reactionOf(last) === "takes_over") return no("took_over");
  // 2. A correct refusal.
  if (last.result === "refused" || last.cause === ("correct_refusal" satisfies TurnCause))
    return no("refused", "correct_refusal");
  // 3. Nothing in the last turn worked.
  if (leftOpen(last))
    return last.failedCalls > 0
      ? no("failed_call", last.cause ?? null)
      : no("no_tool", "missing_capability");
  // 4. The last turn failed or went wrong by its own reading, or the person objected to it.
  if (last.result === "failed")
    return no(
      last.cause && last.cause !== "false_success" ? "failed_call" : "wrong_action",
      last.cause ?? null,
    );
  if (last.result === "completed_wrong")
    return no(last.cause === "incomplete" ? "did_part" : "wrong_action", last.cause ?? null);
  // A correction says the work was the wrong thing, even with no cause named.
  if (objected(last))
    return no(
      last.cause === "incomplete"
        ? "did_part"
        : last.cause || reactionOf(last) === "corrects"
          ? "wrong_action"
          : "unsatisfied",
      last.cause ?? null,
    );
  // 5. The model's answer about the whole task.
  if (verdict && verdict.answer !== "unknown") {
    const sure = verdict.probability === null || verdict.probability >= TASK_ANSWER_MIN_PROBABILITY;
    if (!sure || verdict.answer === "cant_tell")
      return { result: "unknown", reason: null, cause: null, checked, tier, source };
    if (verdict.answer === "not_achieved") return no("goal_missed");
    if (verdict.answer === "partly") return no("did_part", "incomplete");
  }
  // 6 and 7. It ended working.
  const worked = last.okCalls > 0 || last.result === "completed" || verdict?.answer === "achieved";
  if (!worked) return { result: "unknown", reason: null, cause: null, checked, tier, source };
  const friction = frictionOf(ordered);
  return {
    result: friction ? "completed_after_friction" : "completed",
    reason: friction?.reason ?? null,
    cause: friction?.cause ?? null,
    checked,
    tier,
    source,
  };
}

/**
 * What got in the way of a task that still ended working, the most telling
 * first: the person correcting the agent, then asking again, then a call that
 * failed before one worked, then a search that found nothing at first. Null
 * when nothing did. The cause is the turn's, where one was read.
 */
function frictionOf(
  turns: readonly TaskTurn[],
): { reason: FrictionReason; cause: string | null } | null {
  const corrected = turns.find(
    (turn) =>
      turn.result === "completed_wrong" || (objected(turn) && reactionOf(turn) !== "repeats"),
  );
  if (corrected) return { reason: "corrected", cause: corrected.cause ?? null };
  const repeated = turns.find((turn) => reactionOf(turn) === "repeats");
  if (repeated) return { reason: "repeated", cause: repeated.cause ?? null };
  const failed = turns.find((turn) => turn.streaks > 0 || turn.result === "failed");
  if (failed) return { reason: "recovered_call", cause: failed.cause ?? null };
  if (turns.some((turn) => turn.unmetSearches > 0))
    return { reason: "searched_again", cause: "missing_capability" };
  return null;
}
