import {
  type OutcomeAsk,
  type OutcomeQuestion,
  type OutcomeVerdict,
  UNKNOWN_ANSWER,
} from "@/lib/readings/trace-signals/outcomes/ask";
import {
  MODEL_CAUSES,
  type ModelCause,
  NEGATIVE_REACTIONS,
  type OutcomeCause,
  REACTIONS,
  type Reaction,
  type Satisfaction,
} from "@/lib/readings/trace-signals/outcomes/kinds";
import {
  clip,
  OUTCOME_MAX_MESSAGE_CHARS,
  OUTCOME_MAX_REPLY_CHARS,
} from "@/lib/readings/trace-signals/outcomes/question-content";

/**
 * The eight closed questions of the model layer, and when each is asked.
 * Every question has a fixed wording, fixed answers and a version; raising a
 * version asks it again (`ask.ts`). The model only ever answers these: what a
 * turn came to is decided in code from its answers and the rule facts.
 *
 * About a turn's own work (the person's message, the calls, the reply):
 *   completed      every turn with user text
 *   claims         only when the trace says something went wrong (a failed
 *                  call, or a search run nothing was run for) and the reply
 *                  was captured: a reply that says "done" over an error
 *   asks           every turn with user text: is the message a request
 *   cause          second pass, only when the turn went wrong and the rules
 *                  leave the cause open ({@link causeAsk})
 * About how the person's next message takes the turn (needs a next message):
 *   satisfied, reaction, misunderstood
 *                  every turn with user text, because no rule flags a turn
 *                  where every call succeeded
 * About the agent's own search queries (no user text needed):
 *   search_run     a turn that ends on a search run with no call after it
 *
 * A project that sends no user text gets only `search_run`.
 *
 * The wordings of `satisfied`, `asks` and `completed`, and the layout of the
 * content they read, are the ones tried on the mock conversations
 * (sage2-test) and stay verbatim. `reaction` is one choice, not tags: a tags
 * question is billed once per tag.
 *
 * PRIVACY: contents are built in memory from captured text, sent and
 * dropped. Only the closed answers are kept.
 */

const yesno = (
  id: string,
  instructions: string,
  more: Partial<OutcomeQuestion> = {},
): OutcomeQuestion => ({ id, version: 1, kind: "yesno", instructions, ...more });

export const SATISFIED_QUESTION = yesno(
  "satisfied",
  "A person sent this message to an AI agent that works for them, after the agent did something for them. Is the person satisfied with what the agent did?",
  { mayReason: true },
);

export const REQUEST_QUESTION = yesno(
  "asks",
  "In their last message, is the person asking the agent to do something: a new request, or to do something again or differently?",
);

export const COMPLETED_QUESTION = yesno(
  "completed",
  "Did the agent complete what the person asked?",
);

export const MISUNDERSTOOD_QUESTION = yesno(
  "misunderstood",
  "Did the agent act on the wrong thing or misunderstand what the person asked for?",
);

export const CLAIMS_QUESTION = yesno(
  "claims",
  "Does the agent say that it has done what the person asked?",
);

const REACTION_DESCRIPTIONS: Record<Reaction, string> = {
  satisfied: "The person thanks the agent or says the result is good.",
  corrects: "The person says the agent got something wrong or did something they did not ask for.",
  repeats: "The person asks again for the same thing they already asked for.",
  gives_up: "The person stops trying to get this done with the agent.",
  asks_human: "The person asks for a human, a manager or a support team.",
  takes_over: "The person says they will do it themselves or get it done elsewhere.",
  new_request:
    "The person asks for something new or changes what they want, and does not say the agent got anything wrong.",
};

export const REACTION_QUESTION: OutcomeQuestion = {
  id: "reaction",
  version: 1,
  kind: "choice",
  instructions: "What does the person do in their last message?",
  options: REACTIONS.map((option) => ({ option, description: REACTION_DESCRIPTIONS[option] })),
};

const CAUSE_DESCRIPTIONS: Record<ModelCause, string> = {
  misread_request: "The agent acted on the wrong thing or misunderstood what the person asked for.",
  ignored_instruction: "The agent broke a limit or instruction the person stated explicitly.",
  missing_capability: "The agent has no way to do what was asked.",
  incomplete: "The agent did only part of what was asked.",
  false_success: "The agent said the work was done when it was not.",
  over_asking:
    "The agent asked questions or made offers the person did not need instead of doing the work.",
  unhelpful_answer:
    "The agent answered without addressing the person's point, or gave no reason or next step.",
  correct_refusal: "The agent correctly refused because a rule or policy does not allow it.",
  unclear_request: "The person's request was too unclear to act on.",
};

/** The cause question's answer when nothing went wrong. */
export const NO_CAUSE = "none";

export const CAUSE_QUESTION: OutcomeQuestion = {
  id: "cause",
  version: 1,
  kind: "choice",
  instructions: "What went wrong with the agent's work? Pick the main reason.",
  options: [
    ...MODEL_CAUSES.map((option) => ({ option, description: CAUSE_DESCRIPTIONS[option] })),
    { option: NO_CAUSE, description: "Nothing went wrong with the agent's work." },
  ],
};

/** What a search run with no call after it was. */
export const SEARCH_RUN_MEANINGS = ["one_need", "several_needs", "browsing"] as const;

export type SearchRunMeaning = (typeof SEARCH_RUN_MEANINGS)[number];

const SEARCH_RUN_DESCRIPTIONS: Record<SearchRunMeaning, string> = {
  one_need:
    "Every query asks for the same thing in other words: the agent looked for one tool and did not find it.",
  several_needs: "The queries ask for different things: the agent looked for more than one tool.",
  browsing:
    "The queries are broad or generic: the agent was looking at what tools exist, not for one thing.",
};

export const SEARCH_RUN_QUESTION: OutcomeQuestion = {
  id: "search_run",
  version: 1,
  kind: "choice",
  instructions:
    "An AI agent searched its tool catalog with these queries, one after another, and then ran no tool. What do the queries show?",
  options: SEARCH_RUN_MEANINGS.map((option) => ({
    option,
    description: SEARCH_RUN_DESCRIPTIONS[option],
  })),
};

/** The eight questions, in the order a turn's asks are put under the cap. */
export const OUTCOME_QUESTIONS = [
  SATISFIED_QUESTION,
  REACTION_QUESTION,
  MISUNDERSTOOD_QUESTION,
  COMPLETED_QUESTION,
  REQUEST_QUESTION,
  CLAIMS_QUESTION,
  CAUSE_QUESTION,
  SEARCH_RUN_QUESTION,
] as const;

/** One call of a turn as a question reads it. */
export interface QuestionCall {
  /** The tool's id. */
  tool: string;
  outcome: "ok" | "error" | "unknown";
  /** The error's own text, when the call failed and the message could be read. */
  error?: string | null;
}

/** One exchange: what the person asked, what the agent did, what it replied. */
export interface QuestionExchange {
  /** The person's message. */
  request: string;
  calls: readonly QuestionCall[];
  /** The agent's reply; null when the project captures no content (`replyToSend`). */
  reply: string | null;
}

/** One turn as the questions read it: built from the turn, its neighbours in the session and its search queries. */
export interface QuestionTurn {
  turnId: string;
  /** The person's message that started the turn; null when the project sent none. */
  request: string | null;
  calls: readonly QuestionCall[];
  reply: string | null;
  /** The exchange before this turn in its session, when it can be told whole; null otherwise. */
  previous: QuestionExchange | null;
  /** The person's next message in the session; null when there is none yet. */
  next: string | null;
  /** The queries of the search run that ends the turn with no call after it; empty when there is none. */
  unmetQueries: readonly string[];
}

/** The rule facts that decide which questions a turn gets. */
export interface QuestionRuleFacts {
  failedCalls: number;
  unmetSearches: number;
  /** The rule layer's cause of the leading failure; null when no call failed or none could be read. */
  cause: OutcomeCause | null;
}

const MAX_ERROR_CHARS = 160;
const MAX_QUERY_CHARS = 200;
const MAX_CALLS = 30;
const MAX_QUERIES = 12;

/** A turn's calls in one line: `tool (ok); tool (error: message)`, or `nothing`. */
export function describeCalls(calls: readonly QuestionCall[]): string {
  if (calls.length === 0) return "nothing";
  const parts = calls.slice(0, MAX_CALLS).map((call) => {
    if (call.outcome === "ok") return `${call.tool} (ok)`;
    if (call.outcome === "unknown") return `${call.tool} (no result)`;
    return `${call.tool} (error: ${call.error ? clip(call.error, MAX_ERROR_CHARS) : ""})`;
  });
  if (calls.length > MAX_CALLS) parts.push(`and ${calls.length - MAX_CALLS} more`);
  return parts.join("; ");
}

/** An exchange as a question reads it: the ask, the calls with their outcome and the reply when there is one. */
export function workContent(exchange: QuestionExchange): string {
  const lines = [
    `The person asked: ${clip(exchange.request, OUTCOME_MAX_MESSAGE_CHARS)}`,
    `The agent did: ${describeCalls(exchange.calls)}`,
  ];
  if (exchange.reply)
    lines.push(`The agent replied: ${clip(exchange.reply, OUTCOME_MAX_REPLY_CHARS)}`);
  return lines.join("\n");
}

/** An exchange and the person's message after it. */
export function followUpContent(exchange: QuestionExchange, message: string): string {
  return `${workContent(exchange)}\nThe person then said: ${clip(message, OUTCOME_MAX_MESSAGE_CHARS)}`;
}

/** A search run's queries, in order. */
export function searchRunContent(queries: readonly string[]): string {
  return queries
    .slice(0, MAX_QUERIES)
    .map((query, i) => `${i + 1}. ${clip(query, MAX_QUERY_CHARS)}`)
    .join("\n");
}

/** The key of one question's answer about one turn. */
export const askKey = (turnId: string, question: OutcomeQuestion): string =>
  `${turnId}:${question.id}`;

const exchangeOf = (turn: QuestionTurn & { request: string }): QuestionExchange => ({
  request: turn.request,
  calls: turn.calls,
  reply: turn.reply,
});

/**
 * The first pass: every question a turn gets before any answer is known, in
 * the order they matter. A turn with no user text gets only the search-run
 * question.
 */
export function turnAsks(turn: QuestionTurn, rule: QuestionRuleFacts): OutcomeAsk[] {
  const asks: OutcomeAsk[] = [];
  const add = (question: OutcomeQuestion, content: string) =>
    asks.push({ key: askKey(turn.turnId, question), question, content });
  if (turn.request !== null) {
    const exchange = exchangeOf({ ...turn, request: turn.request });
    if (turn.next !== null) {
      const followUp = followUpContent(exchange, turn.next);
      add(SATISFIED_QUESTION, followUp);
      add(REACTION_QUESTION, followUp);
      add(MISUNDERSTOOD_QUESTION, followUp);
    }
    const work = workContent(exchange);
    add(COMPLETED_QUESTION, work);
    // The message alone when the exchange before it cannot be told: a request reads the same either way.
    add(
      REQUEST_QUESTION,
      turn.previous
        ? followUpContent(turn.previous, turn.request)
        : clip(turn.request, OUTCOME_MAX_MESSAGE_CHARS),
    );
    if (turn.reply !== null && (rule.failedCalls > 0 || rule.unmetSearches > 0))
      add(CLAIMS_QUESTION, work);
  }
  if (turn.unmetQueries.length > 0) add(SEARCH_RUN_QUESTION, searchRunContent(turn.unmetQueries));
  return asks;
}

export type YesNo = "yes" | "no";

/** A turn's answers. A null field was not asked, or not answered yet; `unknown` was asked and the model did not decide. */
export interface TurnAnswers {
  satisfied: YesNo | typeof UNKNOWN_ANSWER | null;
  reaction: Reaction | typeof UNKNOWN_ANSWER | null;
  misunderstood: YesNo | typeof UNKNOWN_ANSWER | null;
  completed: YesNo | typeof UNKNOWN_ANSWER | null;
  asks: YesNo | typeof UNKNOWN_ANSWER | null;
  claims: YesNo | typeof UNKNOWN_ANSWER | null;
  cause: ModelCause | typeof NO_CAUSE | typeof UNKNOWN_ANSWER | null;
  searchRun: SearchRunMeaning | typeof UNKNOWN_ANSWER | null;
}

export const NO_ANSWERS: TurnAnswers = {
  satisfied: null,
  reaction: null,
  misunderstood: null,
  completed: null,
  asks: null,
  claims: null,
  cause: null,
  searchRun: null,
};

function answerOf<T extends string>(
  verdicts: ReadonlyMap<string, OutcomeVerdict>,
  turnId: string,
  question: OutcomeQuestion,
  allowed: readonly T[],
): T | typeof UNKNOWN_ANSWER | null {
  const verdict = verdicts.get(askKey(turnId, question));
  if (!verdict) return null;
  return (allowed as readonly string[]).includes(verdict.answer)
    ? (verdict.answer as T)
    : UNKNOWN_ANSWER;
}

const YES_NO: readonly YesNo[] = ["yes", "no"];

/** A turn's answers read from the verdicts of its asks. */
export function readAnswers(
  turnId: string,
  verdicts: ReadonlyMap<string, OutcomeVerdict>,
): TurnAnswers {
  return {
    satisfied: answerOf(verdicts, turnId, SATISFIED_QUESTION, YES_NO),
    reaction: answerOf(verdicts, turnId, REACTION_QUESTION, REACTIONS),
    misunderstood: answerOf(verdicts, turnId, MISUNDERSTOOD_QUESTION, YES_NO),
    completed: answerOf(verdicts, turnId, COMPLETED_QUESTION, YES_NO),
    asks: answerOf(verdicts, turnId, REQUEST_QUESTION, YES_NO),
    claims: answerOf(verdicts, turnId, CLAIMS_QUESTION, YES_NO),
    cause: answerOf(verdicts, turnId, CAUSE_QUESTION, [...MODEL_CAUSES, NO_CAUSE]),
    searchRun: answerOf(verdicts, turnId, SEARCH_RUN_QUESTION, SEARCH_RUN_MEANINGS),
  };
}

/** Whether any question about the turn was answered. */
export const answered = (answers: TurnAnswers): boolean =>
  Object.values(answers).some((answer) => answer !== null);

const isNegative = (reaction: TurnAnswers["reaction"]): boolean =>
  reaction !== null && reaction !== UNKNOWN_ANSWER && NEGATIVE_REACTIONS.includes(reaction);

/**
 * How the person's next message takes the turn; null when nothing was asked
 * about it.
 *
 * Unsatisfied needs the person to push back: a correction, a repeat, giving
 * up, asking for a human or taking over. A plain new request is `neutral`
 * whatever the satisfaction question says: moving on says nothing against
 * the turn before. A "no" with no reaction decided is `unknown`, not
 * unsatisfied. Chosen on held-out turns of a real project and of a
 * chat mock (2026-11-19): it halves the turns
 * read as unsatisfied that were not.
 */
export function satisfactionOf(
  answers: Pick<TurnAnswers, "satisfied" | "reaction">,
): Satisfaction | null {
  const { satisfied, reaction } = answers;
  if (satisfied === null && reaction === null) return null;
  if (isNegative(reaction)) return "unsatisfied";
  if (reaction === "new_request") return "neutral";
  if (satisfied === "no")
    return reaction === null || reaction === UNKNOWN_ANSWER ? "unknown" : "unsatisfied";
  if (satisfied === "yes" || reaction === "satisfied") return "satisfied";
  return "unknown";
}

/**
 * Whether the answers of the first pass say the turn went wrong for the
 * person: they are unsatisfied, the agent misunderstood, or it did not
 * complete what was asked.
 */
export function wentWrong(answers: TurnAnswers): boolean {
  return (
    satisfactionOf(answers) === "unsatisfied" ||
    answers.misunderstood === "yes" ||
    answers.completed === "no"
  );
}

/**
 * The rules decided why the turn failed: a failed call whose error has a
 * known cause, or a search no listed tool fits (a missing tool). The
 * writers agree: a cause the rules decided is never replaced by a model's.
 */
export function ruleDecidesCause(rule: QuestionRuleFacts): boolean {
  if (rule.cause !== null && rule.cause !== "other") return true;
  return rule.failedCalls === 0 && rule.unmetSearches > 0;
}

/**
 * The second pass: the cause question, asked only when the turn went wrong
 * and the rules leave the cause open. Bad arguments, a wrong reference, a
 * tool fault, no access and a missing tool are decided by the rules.
 */
export function causeAsk(
  turn: QuestionTurn,
  rule: QuestionRuleFacts,
  answers: TurnAnswers,
): OutcomeAsk | null {
  if (turn.request === null || !wentWrong(answers) || ruleDecidesCause(rule)) return null;
  const exchange = exchangeOf({ ...turn, request: turn.request });
  const content = turn.next !== null ? followUpContent(exchange, turn.next) : workContent(exchange);
  return { key: askKey(turn.turnId, CAUSE_QUESTION), question: CAUSE_QUESTION, content };
}

/**
 * The cause the model layer gives a turn, or null: the cause question's
 * answer, else a missing capability when a search run looked for one tool
 * and found none. Never set over a cause the rules decided
 * (`ruleDecidesCause`): the writer keeps the rule's.
 */
export function modelCauseOf(answers: TurnAnswers): ModelCause | null {
  if (answers.cause !== null && answers.cause !== UNKNOWN_ANSWER && answers.cause !== NO_CAUSE)
    return answers.cause;
  return answers.searchRun === "one_need" ? "missing_capability" : null;
}

/** What the model layer writes on a turn's row. A null field leaves the column as it is. */
export interface TurnAnswerRow {
  turnId: string;
  satisfaction: Satisfaction | null;
  reaction: Reaction | typeof UNKNOWN_ANSWER | null;
  claimedDone: boolean | null;
  request: boolean | null;
  cause: ModelCause | null;
}

const bool = (answer: YesNo | typeof UNKNOWN_ANSWER | null): boolean | null =>
  answer === "yes" ? true : answer === "no" ? false : null;

/** A turn's answers as its row keeps them: closed values only. */
export function answerRow(turnId: string, answers: TurnAnswers): TurnAnswerRow {
  return {
    turnId,
    satisfaction: satisfactionOf(answers),
    reaction: answers.reaction,
    claimedDone: bool(answers.claims),
    request: bool(answers.asks),
    cause: modelCauseOf(answers),
  };
}
