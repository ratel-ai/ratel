import {
  type FrictionReason,
  type FusionSource,
  MODEL_CAUSES,
  OUTCOME_CAUSES,
  REACTIONS,
  type Reaction,
  RULE_SESSION_OUTCOMES,
  type Satisfaction,
  SESSION_OUTCOMES,
  type SessionOutcome,
  type TaskReason,
  type TaskTier,
  type TurnCause,
} from "@/lib/readings/trace-signals/outcomes/kinds";
import type { TaskFilter } from "@/lib/views/traces/sentiment/page-paths";

/**
 * How the Sentiment analysis page words the stored outcome values: a label, a
 * meaning and, for a cause, who fixes it. The values themselves are the
 * shared list's (`kinds.ts`), the one the rule layer, the model layer and the
 * fusion write from, so the page never reads a name nothing writes. Every
 * table here is keyed by a shared type: a value added to `kinds.ts` without
 * its words here fails the build.
 *
 * Two causes are the page's own, read from a row and never stored: a failed
 * call whose message was not kept, and a turn the person was not satisfied
 * with although no call failed and no cause was read.
 */

/** Causes the page derives from a row. */
export const PAGE_CAUSES = ["no_failure", "unread"] as const;

export type PageCause = (typeof PAGE_CAUSES)[number];

/** Why a request went wrong, as a row of the page names it: every stored cause, then the page's own. */
export type RootCause = TurnCause | PageCause;

export const ROOT_CAUSES: readonly RootCause[] = [
  ...OUTCOME_CAUSES,
  ...MODEL_CAUSES,
  ...PAGE_CAUSES,
];

/**
 * Whose dissatisfaction a cause is, as What drives dissatisfaction groups it:
 *   agent   the agent got it wrong (a misread request, an ignored instruction,
 *           unfinished work, a false "done", bad arguments, a record that does
 *           not exist): the agent needs to be improved;
 *   system  the agent was fine but what it runs on was not (a tool that
 *           failed, access refused, no tool for the job);
 *   other   everything else: an error nothing could read, a request too
 *           unclear to act on, a correct refusal, and no cause found.
 */
export const DISSATISFACTION_GROUPS = ["agent", "system", "other"] as const;

export type DissatisfactionGroup = (typeof DISSATISFACTION_GROUPS)[number];

export const DISSATISFACTION_GROUP_OF: Record<RootCause, DissatisfactionGroup> = {
  bad_arguments: "agent",
  wrong_reference: "agent",
  misread_request: "agent",
  ignored_instruction: "agent",
  incomplete: "agent",
  false_success: "agent",
  over_asking: "agent",
  unhelpful_answer: "agent",
  tool_fault: "system",
  not_allowed: "system",
  missing_capability: "system",
  other: "other",
  unread: "other",
  no_failure: "other",
  correct_refusal: "other",
  unclear_request: "other",
};

export const DISSATISFACTION_GROUP_LABEL: Record<DissatisfactionGroup, string> = {
  agent: "Agent",
  system: "System and operations",
  other: "Other",
};

export const DISSATISFACTION_GROUP_MEANING: Record<DissatisfactionGroup, string> = {
  agent:
    "The agent got it wrong: it misread the request, ignored an instruction, left work unfinished or said it was done when it was not. Improve the agent.",
  system:
    "The agent was fine, but what it runs on was not: a tool failed, access was refused, or no tool it was offered fits.",
  other:
    "Everything else: an error nothing could read, a request too unclear to act on, a correct refusal, and turns where no cause was found.",
};

/** The group of a problem's cause; a problem with no cause found is Other. */
export const dissatisfactionGroupOf = (cause: RootCause | null): DissatisfactionGroup =>
  cause ? DISSATISFACTION_GROUP_OF[cause] : "other";

/** Who can fix a cause. */
export const CAUSE_OWNERS = [
  "prompt",
  "tool_owner",
  "integration_setup",
  "roadmap",
  "nobody",
] as const;

export type CauseOwner = (typeof CAUSE_OWNERS)[number];

/**
 * Who fixes each cause. What the agent did wrong on its own (bad arguments, a
 * wrong reference, a misread request, an ignored instruction, work left
 * undone or called done, too many questions, an answer that did not help) is
 * the prompt's or the tool description's; a tool fault is the tool's; a
 * refused call is how the integration was set up; a request no tool covers
 * is the roadmap's. Nobody has anything to fix after a correct refusal or an
 * unclear request, and a message no pattern knows, or one that is gone, has
 * nobody to send it to yet.
 */
export const CAUSE_OWNER: Record<RootCause, CauseOwner> = {
  bad_arguments: "prompt",
  wrong_reference: "prompt",
  tool_fault: "tool_owner",
  not_allowed: "integration_setup",
  other: "nobody",
  misread_request: "prompt",
  ignored_instruction: "prompt",
  missing_capability: "roadmap",
  incomplete: "prompt",
  false_success: "prompt",
  over_asking: "prompt",
  unhelpful_answer: "prompt",
  correct_refusal: "nobody",
  unclear_request: "nobody",
  no_failure: "prompt",
  unread: "nobody",
};

export const CAUSE_LABEL: Record<RootCause, string> = {
  bad_arguments: "Bad arguments",
  wrong_reference: "Wrong reference",
  tool_fault: "Tool fault",
  not_allowed: "Not allowed",
  other: "Unknown error",
  misread_request: "Misread request",
  ignored_instruction: "Ignored instruction",
  missing_capability: "No fitting tool",
  incomplete: "Left incomplete",
  false_success: "False success",
  over_asking: "Asked too much",
  unhelpful_answer: "Unhelpful answer",
  correct_refusal: "Correct refusal",
  unclear_request: "Unclear request",
  no_failure: "No cause found",
  unread: "Error not kept",
};

/** One line on what a cause means, for the page's hover and its Panel. */
export const CAUSE_MEANING: Record<RootCause, string> = {
  bad_arguments: "The tool refused the arguments the agent sent.",
  wrong_reference: "The agent named a record that does not exist.",
  tool_fault: "The tool failed on its own side.",
  not_allowed: "The tool refused the call: no access or no permission.",
  other: "The error message matches no known shape.",
  misread_request: "The agent did something other than what was asked.",
  ignored_instruction: "The agent left out something the person told it to do.",
  missing_capability:
    "The agent searched, and no tool it was offered does that kind of action, or it said it had no way to do it.",
  incomplete: "The agent did part of the work and stopped.",
  false_success: "The reply said the work was done while the last call failed.",
  over_asking: "The agent asked questions it could have answered itself.",
  unhelpful_answer: "The agent answered, and the answer did not help.",
  correct_refusal: "The agent was right not to do it. It does not count against the agent.",
  unclear_request: "The request could not be told from the person's message.",
  no_failure:
    "Every call worked, but the person was not satisfied, and nothing named why: the agent likely did the wrong thing or answered unhelpfully. The person's words, or a model reading them, would say more.",
  unread: "The call failed and its error message was not kept.",
};

export const OWNER_LABEL: Record<CauseOwner, string> = {
  prompt: "Prompt",
  tool_owner: "Tool owner",
  integration_setup: "Integration setup",
  roadmap: "Roadmap",
  nobody: "Nobody",
};

/** Causes that never count as unresolved: the agent was right. */
export const BLAMELESS_CAUSES: readonly RootCause[] = ["correct_refusal"];

/**
 * A stored cause as the page names it. A value the shared list does not hold
 * (a row of a later version read by an older page) reads as `other` rather
 * than failing the page; `page-kinds.test.ts` fails on any shared value that
 * would take that road.
 */
export function rootCauseOf(value: string | null | undefined): RootCause | null {
  if (!value) return null;
  return ROOT_CAUSES.find((known) => known === value) ?? "other";
}

export const SESSION_OUTCOME_LABEL: Record<SessionOutcome, string> = {
  resolved_clean: "Resolved cleanly",
  resolved_after_friction: "Resolved after friction",
  gave_up: "Gave up",
  blocked: "Blocked",
  escalated: "Escalated",
};

/** The outcomes that count against the agent. */
export const UNRESOLVED_OUTCOMES: readonly SessionOutcome[] = ["gave_up", "blocked", "escalated"];

/** The outcomes only people's messages can show: the ones the rules never write. */
export const TEXT_ONLY_OUTCOMES: readonly SessionOutcome[] = SESSION_OUTCOMES.filter(
  (outcome) => !RULE_SESSION_OUTCOMES.includes(outcome),
);

/**
 * A session's outcome: the stored one, as the fusion wrote it. A row the
 * fusion has not reached yet (written by an older reading) is read from the
 * rule columns alone: resolved cleanly or after friction, or gave up when its
 * last request was left open.
 */
export function sessionOutcomeOf(row: {
  outcome: string | null;
  outcomeSource: string | null;
  frictionCount: number;
  openRequest: boolean;
}): {
  outcome: SessionOutcome;
  source: FusionSource;
} {
  const stored = SESSION_OUTCOMES.find((known) => known === row.outcome);
  if (stored) return { outcome: stored, source: row.outcomeSource === "model" ? "model" : "rule" };
  if (row.openRequest) return { outcome: "gave_up", source: "rule" };
  return {
    outcome: row.frictionCount > 0 ? "resolved_after_friction" : "resolved_clean",
    source: "rule",
  };
}

export const SATISFACTION_LABEL: Record<Satisfaction, string> = {
  satisfied: "Satisfied",
  neutral: "Neutral",
  unsatisfied: "Unsatisfied",
  unknown: "Not decided",
};

/**
 * A reaction as a row holds it: one of the shared list's, or the reaction
 * question asked and not decided, which the model layer stores under the
 * shared list's name for an undecided answer (`unknown`, as a satisfaction).
 */
export const UNDECIDED = "unknown" satisfies Satisfaction;

export type StoredReaction = Reaction | typeof UNDECIDED;

export const STORED_REACTIONS: readonly StoredReaction[] = [...REACTIONS, UNDECIDED];

export const REACTION_LABEL: Record<StoredReaction, string> = {
  satisfied: "Satisfied",
  corrects: "Corrects",
  repeats: "Repeats",
  gives_up: "Gives up",
  asks_human: "Asks for a human",
  takes_over: "Takes over",
  new_request: "New request",
  unknown: "Not decided",
};

export function countsOf<K extends string>(
  keys: readonly K[],
  counts: Readonly<Record<string, number>>,
): Record<K, number> {
  return Object.fromEntries(keys.map((key) => [key, counts[key] ?? 0])) as Record<K, number>;
}

/** A task status as the page shows it. */
export const TASK_FILTER_LABEL: Record<TaskFilter, string> = {
  completed: "Completed",
  completed_after_friction: "Completed after friction",
  not_completed: "Not completed",
};

export const TASK_FILTER_MEANING: Record<TaskFilter, string> = {
  completed: "The work ended working with nothing going wrong on the way.",
  completed_after_friction:
    "The work ended working after a failure, a retry, a correction or a repeat on the way.",
  not_completed: "The goal was not met.",
};

export const TASK_REASON_LABEL: Record<TaskReason, string> = {
  escalated: "Asked for a human",
  gave_up: "Person gave up",
  took_over: "Person did it themselves",
  refused: "Agent refused, rightly",
  failed_call: "Ended on a failed call",
  no_tool: "No fitting tool",
  wrong_action: "Did the wrong thing",
  did_part: "Did only part",
  goal_missed: "Work missed the goal",
  unsatisfied: "Person not satisfied",
};

/** What got in the way of a task completed after friction. */
export const FRICTION_REASON_LABEL: Record<FrictionReason, string> = {
  corrected: "Wrong first, then corrected",
  repeated: "Person asked again",
  recovered_call: "A call failed, then worked",
};

export const FRICTION_REASON_MEANING: Record<FrictionReason, string> = {
  corrected:
    "A turn did the wrong thing, or the person objected to it, and the task was done after.",
  repeated: "The person asked for the same thing again, and the task was done after.",
  recovered_call: "A call failed and a later call worked.",
};

export const TASK_REASON_MEANING: Record<TaskReason, string> = {
  escalated: "The person asked for a human, a manager or support.",
  gave_up: "The person stopped trying.",
  took_over: "The person said they would do it themselves or elsewhere.",
  refused: "The agent declined, and was right to: not held against it.",
  failed_call: "The task's last turn ended with a call that failed and nothing after it worked.",
  no_tool: "The agent searched, and no tool it was offered does that kind of action.",
  wrong_action: "The calls worked, but did the wrong thing.",
  did_part: "Part of what was asked was done.",
  goal_missed: "The calls worked, and the model read that they did not achieve the goal.",
  unsatisfied: "The person was not satisfied, with no clearer reason.",
};

/** A tier as a sentence part: how a task's result was read. */
export const TASK_TIER_LABEL: Record<TaskTier, string> = {
  t0: "from the trace alone",
  t1: "against the agent's own search",
  tr: "with how the person took it inferred from the agent's replies",
  t2: "against the person's request",
  t3: "against the request and what the person said next",
};
