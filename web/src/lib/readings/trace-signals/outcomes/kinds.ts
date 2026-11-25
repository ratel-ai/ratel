/**
 * Sentiment analysis (Agent health), the rule layer's closed vocabulary: what
 * `trace_turn_outcomes` and `trace_session_outcomes` hold besides ids, counts
 * and times. Everything here is read from the trace alone, no model.
 */

/**
 * The version of the rules (the cause patterns, the streak and search-run
 * readings). Stored on every row; raise it when a rule changes what it would
 * write: the next reading rewrites its window and drops older rows elsewhere
 * (`run-queries.ts`), so no page shows an older meaning.
 */
export const OUTCOME_RULE_VERSION = 3;

/** Why a call failed, sorted from its error message (`error-cause.ts`). */
export const OUTCOME_CAUSES = [
  "bad_arguments",
  "wrong_reference",
  "tool_fault",
  "not_allowed",
  "other",
] as const;

export type OutcomeCause = (typeof OUTCOME_CAUSES)[number];

/** Who decided a cause: the pattern table, or a model asked because the rules left it open. */
export type OutcomeCauseSource = "rule" | "model";

/** What followed a failure streak inside its turn (`followed.ts`), best first. */
export const FAILURE_FOLLOWED = [
  "fixed_next_try",
  "fixed_after_detour",
  "switched_tool",
  "nothing_followed",
] as const;

export type FailureFollowed = (typeof FAILURE_FOLLOWED)[number];

/**
 * One failure streak as a turn row keeps it (`trace_turn_outcomes.failures`):
 * consecutive failed calls of one tool. Ids, counts and closed values only.
 */
export interface StoredFailureStreak {
  /** The tool that failed, as a node id (a skill as `skill:<id>`). */
  tool: string;
  /** 1-based ordinal, in the turn, of the streak's first failed call. */
  ordinal: number;
  /** Failed calls in the streak. */
  errors: number;
  /** The streak's most common cause, the earlier one on a tie; null when no error message could be read. */
  cause: OutcomeCause | null;
  followed: FailureFollowed;
  /** A later call in the turn succeeded. */
  recovered: boolean;
}

/**
 * The version of the model layer's questions (`questions.ts`): their wording,
 * their answers and how the answers are read into a row. Stored on a row as
 * `model_version` when a question about its turn was answered.
 */
export const OUTCOME_QUESTION_VERSION = 1;

/**
 * How the person's next message takes a turn (`trace_turn_outcomes.satisfaction`).
 * `neutral` is a plain new request: it says nothing about the turn before it.
 * `unknown` is a question the model was asked and did not decide.
 */
export const SATISFACTIONS = ["satisfied", "neutral", "unsatisfied", "unknown"] as const;

export type Satisfaction = (typeof SATISFACTIONS)[number];

/** What the person does in their next message (`trace_turn_outcomes.reaction`), one choice. */
export const REACTIONS = [
  "satisfied",
  "corrects",
  "repeats",
  "gives_up",
  "asks_human",
  "takes_over",
  "new_request",
] as const;

export type Reaction = (typeof REACTIONS)[number];

/** Reactions that say the turn before them did not give the person what they wanted. */
export const NEGATIVE_REACTIONS: readonly Reaction[] = [
  "corrects",
  "repeats",
  "gives_up",
  "asks_human",
  "takes_over",
];

/**
 * Why a turn went wrong when the rules leave it open: no failed call explains
 * it, so a model is asked (`cause_source = 'model'`). `correct_refusal` is the
 * one that is not the agent's fault.
 */
export const MODEL_CAUSES = [
  "misread_request",
  "ignored_instruction",
  "missing_capability",
  "incomplete",
  "false_success",
  "over_asking",
  "unhelpful_answer",
  "correct_refusal",
  "unclear_request",
] as const;

export type ModelCause = (typeof MODEL_CAUSES)[number];

/** Every value `trace_turn_outcomes.cause` holds. */
export type TurnCause = OutcomeCause | ModelCause;

/**
 * What a turn came to (`trace_turn_outcomes.result`), decided in code from
 * the rule facts and, where they exist, the model's answers (`fusion.ts`).
 * `refused` is a correct refusal: the agent was right not to do it, so it
 * never counts against the agent.
 */
export const TURN_RESULTS = ["completed", "completed_wrong", "failed", "refused"] as const;

export type TurnResult = (typeof TURN_RESULTS)[number];

/** What a session came to for the person (`trace_session_outcomes.outcome`). */
export const SESSION_OUTCOMES = [
  "resolved_clean",
  "resolved_after_friction",
  "gave_up",
  "blocked",
  "escalated",
] as const;

export type SessionOutcome = (typeof SESSION_OUTCOMES)[number];

/**
 * The outcomes the trace alone can support, when no user text was read
 * (`outcome_source = 'rule'`): whether the last request was left open, and
 * whether anything failed on the way. `escalated` needs the person's words.
 */
export const RULE_SESSION_OUTCOMES: readonly SessionOutcome[] = [
  "resolved_clean",
  "resolved_after_friction",
  "gave_up",
  "blocked",
];

/**
 * What a result or an outcome was decided from: `rule` is the trace alone,
 * `model` means a model's answer about the person's text was part of it.
 */
export type FusionSource = "rule" | "model";

/** Causes that mean the agent could not do it at all: no access, no tool for it, or a rule that forbids it. */
export const BLOCKING_CAUSES: readonly TurnCause[] = [
  "not_allowed",
  "missing_capability",
  "correct_refusal",
];

/**
 * TASKS. A session holds one or more tasks: a goal and the work after it
 * (`tasks.ts`). The goal comes from the first source the project sends: the
 * person's request, the agent's own tool search, or nothing.
 */
export const GOAL_SOURCES = ["request", "search", "none"] as const;

export type GoalSource = (typeof GOAL_SOURCES)[number];

/**
 * How much a task's result could be read from (`trace_task_outcomes.tier`).
 * Rates of different tiers are shown apart, never averaged together.
 *   t0  no goal: the trace alone
 *   t1  the agent's own search as the goal, and the trace
 *   tr  as t0 or t1, and how the person took the work inferred from the
 *       agent's replies (`reply-reading.ts`)
 *   t2  the person's request, and the trace
 *   t3  the person's request, the trace and their next message
 */
export const TASK_TIERS = ["t0", "t1", "tr", "t2", "t3"] as const;

export type TaskTier = (typeof TASK_TIERS)[number];

/**
 * What a task came to (`trace_task_outcomes.result`), decided in code.
 * `unknown` is "can't tell": there was nothing to judge by, or the model was
 * unsure. A task whose calls all worked but whose goal nobody checked is
 * `completed` with `checked = false`, and the page shows it apart.
 */
export const TASK_RESULTS = [
  "completed",
  "completed_after_friction",
  "not_completed",
  "unknown",
] as const;

export type TaskResult = (typeof TASK_RESULTS)[number];

/**
 * Why a task was not completed (`trace_task_outcomes.reason`), the first that
 * applies:
 *   escalated       the person asked for a human
 *   gave_up         the person gave up
 *   took_over       the person said they would do it themselves
 *   refused         the agent refused, rightly: not held against it
 *   failed_call     the task ended on a failed call (`cause` says why)
 *   no_tool         the agent searched, and no tool it was offered fits (`search-fit.ts`)
 *   wrong_action    the work ran and was the wrong thing (`cause` says why when a model named it)
 *   did_part        only part of the goal was done
 *   goal_missed     the calls worked, and the model says they did not achieve the goal
 *   unsatisfied     the person was not satisfied, with no other reason
 */
export const TASK_REASONS = [
  "escalated",
  "gave_up",
  "took_over",
  "refused",
  "failed_call",
  "no_tool",
  "wrong_action",
  "did_part",
  "goal_missed",
  "unsatisfied",
] as const;

export type TaskReason = (typeof TASK_REASONS)[number];

/**
 * What got in the way of a task that was still completed
 * (`trace_task_outcomes.reason` of a `completed_after_friction` task), the
 * first that applies:
 *   corrected       the person corrected the agent, or the work was wrong on the way
 *   repeated        the person had to ask again
 *   recovered_call  a call failed and a later one worked
 */
export const FRICTION_REASONS = ["corrected", "repeated", "recovered_call"] as const;

export type FrictionReason = (typeof FRICTION_REASONS)[number];

/** The version of the task rules (segmentation and fusion): stored on every task row. */
export const TASK_RULE_VERSION = 4;

/**
 * What the agent's next reply shows about the message it answers, where the
 * person's own words were not read (`reply-reading.ts`, `trace_turn_outcomes.reply_reaction`).
 */
export const REPLY_REACTIONS = [
  "satisfied",
  "corrects",
  "repeats",
  "asks_human",
  "new_request",
] as const;

export type ReplyReaction = (typeof REPLY_REACTIONS)[number];
