import { leadingStreak } from "@/lib/readings/trace-signals/outcomes/followed";
import {
  REPLY_REACTIONS,
  type ReplyReaction,
  SATISFACTIONS,
  type Satisfaction,
  type SessionOutcome,
  type StoredFailureStreak,
} from "@/lib/readings/trace-signals/outcomes/kinds";
import type { WindowDays } from "@/lib/readings/trace-signals/view";
import { buildOverview, emptyOverview, type Overview } from "@/lib/views/traces/sentiment/overview";
import {
  BLAMELESS_CAUSES,
  countsOf,
  type RootCause,
  rootCauseOf,
  STORED_REACTIONS,
  type StoredReaction,
  sessionOutcomeOf,
} from "@/lib/views/traces/sentiment/page-kinds";
import type { SentimentFilters, SentimentQuery } from "@/lib/views/traces/sentiment/page-paths";

/**
 * The Sentiment analysis page, built from stored outcome rows. Pure: rows in,
 * the page out, no I/O and no clock.
 *
 * A root cause is something that went wrong in a turn: a failure streak (its
 * tool and why its calls failed), a search run nothing was run for, or, where
 * the person's words were read, a turn they were not satisfied with although
 * every call worked (`occurrencesOf`). The page's answer over the window's
 * tasks (completion, satisfaction, the reasons and their root causes, day by
 * day) is `overview.ts`; this module adds what the person's words and the
 * agent's replies showed, and the intents people were most and least
 * satisfied with.
 */

/** The intent filter's value for turns the engine placed nowhere. */
export const NO_INTENT = "none";
/** Intents listed on each side of the satisfaction ranking. */
export const INTENT_SCORE_TOP = 5;

/** A turn with something to explain, as `trace_turn_outcomes` holds it. */
export interface PageTurn {
  turnId: string;
  sessionId: string;
  startedAt: Date;
  endedAt: Date;
  /** What the turn's model calls cost; null when none of them was sent with a cost. */
  costUsd: number | null;
  cause: string | null;
  causeSource: string | null;
  failures: readonly StoredFailureStreak[];
  unmetSearches: number;
  satisfaction: string | null;
  reaction: string | null;
}

/** A session as `trace_session_outcomes` holds it. */
export interface PageSession {
  sessionId: string;
  outcome: string | null;
  outcomeSource: string | null;
  frictionCount: number;
  openRequest: boolean;
  endedAt: Date;
}

/** A task as `trace_task_outcomes` holds it. */
export interface TaskFriction {
  extraTurns: number;
  /** Tokens the friction used; null when no model call was sent with them. */
  tokens: number | null;
  /** Calls that failed and were tried again in the turn that finished it. */
  retriedCalls: number;
  costUsd: number | null;
  timeMs: number;
}

export interface PageTask {
  taskId: string;
  sessionId: string;
  turnIds: string[];
  startedAt: Date;
  endedAt: Date;
  /** What the model calls of its turns cost; null when none was sent with a cost. */
  costUsd: number | null;
  /** Tokens its model calls used (input and output); null when none was sent with them. */
  tokens: number | null;
  /**
   * For a task completed after friction, what the friction spent: the turns
   * before the one that finished it, whole, and in that last turn the calls
   * that failed before one worked (their time and the wait after each, their
   * share of the turn's model cost: an estimate). Cost is null without a
   * costed call. Null for any other task.
   */
  friction: TaskFriction | null;
  tier: string;
  goalSource: string;
  result: string;
  reason: string | null;
  cause: string | null;
  checked: boolean;
}

/** A turn the person said how it went: satisfied or not. Neutral and undecided turns are not answers here. */
export interface PageAnswer {
  turnId: string;
  sessionId: string;
  satisfied: boolean;
  /** When the turn ended: the day it counts on. Absent counts as never on any day. */
  endedAt?: Date;
  /** Read from the agent's next reply, not the person's own words. */
  inferred?: boolean;
}

export interface PageIntent {
  id: string;
  label: string;
}

export interface SentimentPageInput {
  projectId: string;
  windowDays: WindowDays;
  now: Date;
  /** The window's turns with a failed call, an unmet search or an unsatisfied person. */
  turns: readonly PageTurn[];
  sessions: readonly PageSession[];
  /** The window's turns the person said how it went. */
  answers: readonly PageAnswer[];
  /** The window's tasks. */
  tasks: readonly PageTask[];
  /** The intent of each of those turns (and of the answered ones) the engine placed. */
  intents: ReadonlyMap<string, PageIntent>;
  /** Over every turn row of the window. */
  totals: {
    turns: number;
    /** Turns a model answered about. */
    answered: number;
    /** Turn rows whose turn sent the person's message. */
    textTurns: number;
    /** Messages sent in the window, with or without a turn row. */
    messages: number;
    satisfaction: Readonly<Record<string, number>>;
    reactions: Readonly<Record<string, number>>;
    /** How people took turns as the agent's next reply shows it; absent counts as none. */
    replyReactions?: Readonly<Record<string, number>>;
  };
  /** A key for the model is set. */
  modelConfigured: boolean;
  /** The window holds model calls sent with a cost, so cost can be shown and ordered by. */
  costKnown: boolean;
  /** The window held more turns or sessions than were read. */
  capped: boolean;
  minSessions: number;
}

/** How a number was read: by a rule on the trace, by a model, or by both. */
export type ReadBy = "rule" | "model" | "mixed";

export interface InferredReactions {
  /** Turns a reply showed a reaction for. */
  turns: number;
  reactions: Record<ReplyReaction, number>;
  /** Satisfied of those turns; null when none showed satisfied or unsatisfied. */
  score: number | null;
}

/** What the agent's replies show, counted; null when they showed nothing. */
function inferredOf(
  counts: Readonly<Record<string, number>> | undefined,
): InferredReactions | null {
  const reactions = Object.fromEntries(
    REPLY_REACTIONS.map((reaction) => [reaction, counts?.[reaction] ?? 0]),
  ) as Record<ReplyReaction, number>;
  const turns = REPLY_REACTIONS.reduce((sum, reaction) => sum + reactions[reaction], 0);
  if (turns === 0) return null;
  const unhappy = reactions.corrects + reactions.repeats + reactions.asks_human;
  const said = reactions.satisfied + unhappy;
  return { turns, reactions, score: said === 0 ? null : reactions.satisfied / said };
}

/** One intent's satisfaction: satisfied of the turns people said how it went. */
export interface IntentScore {
  intent: PageIntent;
  score: number;
  satisfied: number;
  said: number;
}

export interface IntentScores {
  /** Up to `INTENT_SCORE_TOP` intents scoring above one half, the highest first. */
  satisfied: IntentScore[];
  /** Up to `INTENT_SCORE_TOP` intents scoring below one half, the lowest first. */
  unsatisfied: IntentScore[];
  /** An intent with fewer answers than this is ranked but marked: its score is a hint. */
  fewAnswers: number;
}

export type TextState = "no_text" | "model_off" | "capped" | "read";

export interface SentimentPageModel {
  projectId: string;
  windowDays: WindowDays;
  state: "ready" | "empty" | "unavailable";
  query: SentimentQuery;
  text: {
    state: TextState;
    textTurns: number;
    /** Turns a model answered any question about. */
    answeredTurns: number;
    /** Turns with a satisfaction answer: what the satisfaction counts add up to. A turn can be answered and have none. */
    satisfactionTurns: number;
    satisfaction: Record<Satisfaction, number> | null;
    /** Satisfied turns of those the person said how it went (satisfied or unsatisfied); null when there are none. */
    score: number | null;
    reactions: Record<StoredReaction, number> | null;
    /**
     * How people took turns, inferred from the agent's next reply where their
     * own words were not read (`reply-reading.ts`); null when no reply showed it.
     */
    inferred: InferredReactions | null;
  };
  /** Intents by satisfaction score; null when people's messages were not read and no reply showed how they took it. */
  intentScores: IntentScores | null;
  /** The page's answer over those tasks: completion, satisfaction, the reasons and their root causes, day by day (`overview.ts`). */
  overview: Overview;
  /** Model calls were sent with a cost: the cost column and order show. */
  costKnown: boolean;
  /** The label of the intent the page is narrowed to; null when it is narrowed to none. */
  intentLabel: string | null;
  capped: boolean;
}

/** The Monday (UTC) of the week `date` is in, as `YYYY-MM-DD`. */
export function weekOf(date: Date): string {
  const day = (date.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day))
    .toISOString()
    .slice(0, 10);
}

/** One thing that went wrong in one turn. */
export interface Occurrence {
  turn: PageTurn;
  cause: RootCause;
  source: ReadBy;
  tool: string | null;
  errors: number;
  /** Not recovered from, or the person was unsatisfied. Never for a cause that is not the agent's doing. */
  unresolved: boolean;
}

/**
 * What went wrong in a turn, one occurrence per cause and tool:
 *   - each failure streak, under the cause the rules sorted its errors into.
 *     A streak the rules left open takes the cause a model chose for the
 *     turn, when it is the turn's leading failure (the one the model was
 *     asked about);
 *   - a search run nothing was run for: no tool for it, the same cause a
 *     model names when the agent says it cannot do something;
 *   - a cause a model chose for a turn in which no streak took it: a turn
 *     that went wrong with every call working;
 *   - with none of these, a turn the person was not satisfied with.
 * A correct refusal is listed and never unresolved: the agent was right.
 */
export function occurrencesOf(turn: PageTurn): Occurrence[] {
  const unsatisfied = turn.satisfaction === "unsatisfied";
  const modelCause = turn.causeSource === "model" ? rootCauseOf(turn.cause) : null;
  const leading = leadingStreak(turn.failures);
  const out = new Map<string, Occurrence>();
  const add = (next: Omit<Occurrence, "turn">) => {
    const key = `${next.cause}\u0000${next.tool ?? ""}`;
    const seen = out.get(key);
    const occurrence = {
      ...next,
      unresolved: next.unresolved && !BLAMELESS_CAUSES.includes(next.cause),
    };
    if (!seen) out.set(key, { turn, ...occurrence });
    else {
      out.set(key, {
        ...seen,
        errors: seen.errors + occurrence.errors,
        unresolved: seen.unresolved || occurrence.unresolved,
        source: seen.source === occurrence.source ? seen.source : "mixed",
      });
    }
  };
  let taken = false;
  for (const streak of turn.failures) {
    const open = streak.cause === null || streak.cause === "other";
    const byModel = open && streak === leading && modelCause !== null;
    if (byModel) taken = true;
    add({
      cause: byModel ? modelCause : (streak.cause ?? "unread"),
      source: byModel ? "model" : "rule",
      tool: streak.tool,
      errors: streak.errors,
      unresolved: !streak.recovered || unsatisfied,
    });
  }
  if (turn.unmetSearches > 0) {
    add({
      cause: "missing_capability",
      source: "rule",
      tool: null,
      errors: 0,
      unresolved: turn.satisfaction !== "satisfied",
    });
  }
  if (modelCause !== null && !taken) {
    add({ cause: modelCause, source: "model", tool: null, errors: 0, unresolved: true });
  } else if (out.size === 0 && unsatisfied) {
    add({ cause: "no_failure", source: "model", tool: null, errors: 0, unresolved: true });
  }
  return [...out.values()];
}

const text = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The intents people were most and least satisfied with, from the turns they
 * said how it went in: every intent with an answer is ranked, five a side, and
 * on equal scores the one with more answers comes first. One scoring exactly
 * one half is on neither side. Fewer answers than `fewAnswers` mark a score as
 * a hint, not a pattern.
 */
function intentScoresOf(
  answers: readonly PageAnswer[],
  intents: ReadonlyMap<string, PageIntent>,
  fewAnswers: number,
): IntentScores {
  const byIntent = new Map<string, { intent: PageIntent; satisfied: number; said: number }>();
  for (const answer of answers) {
    const intent = intents.get(answer.turnId);
    if (!intent) continue;
    const entry = byIntent.get(intent.id) ?? { intent, satisfied: 0, said: 0 };
    byIntent.set(intent.id, entry);
    entry.said += 1;
    if (answer.satisfied) entry.satisfied += 1;
  }
  const ranked = [...byIntent.values()].map((entry) => ({
    ...entry,
    score: entry.satisfied / entry.said,
  }));
  const byScore = (a: IntentScore, b: IntentScore) =>
    b.score - a.score || b.said - a.said || text(a.intent.label, b.intent.label);
  return {
    satisfied: ranked
      .filter((entry) => entry.score > 0.5)
      .sort(byScore)
      .slice(0, INTENT_SCORE_TOP),
    unsatisfied: ranked
      .filter((entry) => entry.score < 0.5)
      .sort((a, b) => a.score - b.score || b.said - a.said || text(a.intent.label, b.intent.label))
      .slice(0, INTENT_SCORE_TOP),
    fewAnswers,
  };
}

/**
 * The window's tasks under the filters a task has: its intent (its first
 * turn's), how its session ended and the week it ended. The turn filters
 * (cause, tool) and its own (result, reason) are the overview's.
 */
function scopedTasks(
  input: SentimentPageInput,
  filters: SentimentFilters,
  outcomeOf: ReadonlyMap<string, SessionOutcome>,
): PageTask[] {
  return input.tasks.filter((task) => {
    if (
      filters.intent !== null &&
      (input.intents.get(task.taskId)?.id ?? NO_INTENT) !== filters.intent
    )
      return false;
    if (filters.outcome !== null && outcomeOf.get(task.sessionId) !== filters.outcome) return false;
    if (filters.week !== null && weekOf(task.endedAt) !== filters.week) return false;
    return true;
  });
}

/** Satisfied of the turns the person said how it went; null when nobody did. */
function scoreOf(satisfaction: Record<Satisfaction, number> | null): number | null {
  if (!satisfaction) return null;
  const said = satisfaction.satisfied + satisfaction.unsatisfied;
  return said === 0 ? null : satisfaction.satisfied / said;
}

function textState(input: SentimentPageInput): TextState {
  const { textTurns, answered, messages } = input.totals;
  if (messages === 0 && textTurns === 0 && answered === 0) return "no_text";
  if (answered === 0 && !input.modelConfigured) return "model_off";
  return answered < textTurns ? "capped" : "read";
}

export function buildSentimentPage(
  input: SentimentPageInput,
  asked: SentimentQuery,
): SentimentPageModel {
  // Without a costed model call there is nothing to order by cost.
  const query: SentimentQuery =
    asked.sort === "cost" && !input.costKnown ? { ...asked, sort: "impact" } : asked;
  const { filters } = query;
  const outcomeOf = new Map(
    input.sessions.map((session) => [session.sessionId, sessionOutcomeOf(session).outcome]),
  );
  const state = textState(input);
  const read = state === "capped" || state === "read";
  const satisfaction = read ? countsOf(SATISFACTIONS, input.totals.satisfaction) : null;
  const empty = input.totals.turns === 0 && input.sessions.length === 0;
  const inScope = scopedTasks(input, filters, outcomeOf);
  return {
    projectId: input.projectId,
    windowDays: input.windowDays,
    state: empty ? "empty" : "ready",
    query,
    text: {
      state,
      textTurns: input.totals.textTurns,
      answeredTurns: input.totals.answered,
      satisfactionTurns: satisfaction
        ? SATISFACTIONS.reduce((sum, key) => sum + satisfaction[key], 0)
        : 0,
      satisfaction,
      score: scoreOf(satisfaction),
      reactions: read ? countsOf(STORED_REACTIONS, input.totals.reactions) : null,
      inferred: inferredOf(input.totals.replyReactions),
    },
    // Under a session outcome, the intents of sessions that ended that way. Answers read from the agent's replies count too.
    intentScores:
      read || input.answers.length > 0
        ? intentScoresOf(
            filters.outcome
              ? input.answers.filter(
                  (answer) => outcomeOf.get(answer.sessionId) === filters.outcome,
                )
              : input.answers,
            input.intents,
            input.minSessions,
          )
        : null,
    costKnown: input.costKnown,
    intentLabel: intentLabelOf(input.intents, filters.intent),
    overview: buildOverview({
      tasks: inScope,
      answers: input.answers,
      occurrences: input.turns.flatMap(occurrencesOf),
      filters,
      sort: query.sort,
      costKnown: input.costKnown,
      now: input.now,
      windowDays: input.windowDays,
    }),
    capped: input.capped,
  };
}

/** The label of the intent an intent filter names; "No intent" for turns the engine placed nowhere. */
function intentLabelOf(
  intents: ReadonlyMap<string, PageIntent>,
  intent: string | null,
): string | null {
  if (intent === null) return null;
  if (intent === NO_INTENT) return "No intent";
  for (const known of intents.values()) if (known.id === intent) return known.label;
  return intent;
}

/** The page when its rows could not be read. */
export function unavailableSentimentPage(
  projectId: string,
  windowDays: WindowDays,
  query: SentimentQuery,
): SentimentPageModel {
  return {
    projectId,
    windowDays,
    state: "unavailable",
    query,
    text: {
      state: "no_text",
      textTurns: 0,
      answeredTurns: 0,
      satisfactionTurns: 0,
      satisfaction: null,
      score: null,
      reactions: null,
      inferred: null,
    },
    intentScores: null,
    overview: emptyOverview(),
    costKnown: false,
    intentLabel: null,
    capped: false,
  };
}
