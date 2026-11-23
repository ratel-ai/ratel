import type { ClosedQuestionFailureReason } from "@/lib/contracts/closed-questions";
import { lexiconSentiment } from "@/lib/readings/topics/sentiment";
import {
  type AskDeps,
  askQuestions,
  type OutcomeVerdict,
} from "@/lib/readings/trace-signals/outcomes/ask";
import { OUTCOME_QUESTION_VERSION } from "@/lib/readings/trace-signals/outcomes/kinds";
import { replyToSend } from "@/lib/readings/trace-signals/outcomes/question-content";
import {
  answered,
  answerRow,
  causeAsk,
  NO_ANSWERS,
  type QuestionCall,
  type QuestionExchange,
  type QuestionRuleFacts,
  type QuestionTurn,
  readAnswers,
  satisfactionOf,
  type TurnAnswerRow,
  type TurnAnswers,
  turnAsks,
} from "@/lib/readings/trace-signals/outcomes/questions";
import {
  type ReplyReaction,
  replyAsk,
  replyAskKey,
  replyReactionOf,
} from "@/lib/readings/trace-signals/outcomes/reply-reading";
import {
  type TaskExchange,
  type TaskQuestionInput,
  taskAsk,
  taskAskKey,
  taskVerdictOf,
} from "@/lib/readings/trace-signals/outcomes/task-question";
import { segmentTasks, type TaskVerdict } from "@/lib/readings/trace-signals/outcomes/tasks";

/**
 * The model layer of an outcome reading: the window's turns, the text the
 * project captured around them, and the closed questions asked about each
 * (`questions.ts`), capped and cached (`ask.ts`).
 *
 * A turn's inputs are built from the turn and its session: the person's
 * message that started it (the SDK's `turn_start.user_message`), the calls
 * with their outcome, the agent's reply when the project captures content,
 * the exchange before it and the person's next message. A message with no
 * call after it (a "thanks") has no turn in the ledger; it is still the next
 * message of the turn before it.
 *
 * Two passes: the questions every turn gets, then the cause question for the
 * turns whose answers say they went wrong while the rules leave the cause
 * open. Both share one cap.
 *
 * The person's message per turn comes from an SDK turn scope
 * (`turn_start.user_message`) or, for a turn of the OTel lane, from the
 * prompt its trace's first model call carries (the ask, as Topics reads it).
 *
 * Where the questions leave a turn's satisfaction open (past the cap, or not
 * decided), the person's next message is read by the Topics lexicon
 * (`lib/topics/sentiment.ts`), clear phrases only: thanks reads satisfied,
 * "that's wrong" or "still not" unsatisfied. A turn the person wrote after
 * with neither is `neutral`: they moved on.
 *
 * A message whose opening words recur across sessions is machine-written (an
 * orchestrator's nudge, a checker's report, a tool's notice), not a person's
 * reaction: it is never read as how the person took the turn before it, and
 * a turn it starts gets no questions about the person.
 *
 * PRIVACY: messages, replies, queries and error text are read for the turns
 * of one run, held in memory, sent and dropped. Nothing here stores or logs
 * them.
 */

/** One turn of the window as the walk hands it over. */
export interface ModelTurn {
  turnId: string;
  sessionId: string;
  /** When the turn started: tasks are cut in this order. */
  startedAt: Date;
  /** The ledger's turn key: `declared:<turn id>` for an SDK turn scope, `otlp:<trace id>` for an OTel run. */
  turnKey: string | null;
  calls: QuestionCall[];
  /** The `trace_events` ids of the searches of the run that ends the turn with no call after it. */
  unmetSearchEvents: string[];
  /** The `trace_events` ids of every search of the turn, in order: a trace-only task's goal. */
  searchEvents: string[];
  rule: QuestionRuleFacts;
}

/** One message a person sent: an SDK turn scope's message, or an OTel run's prompt. */
export interface SessionMessage {
  sessionId: string;
  /** The turn scope's own id (`turn_start.turn_id`), or an OTel run's ledger key (`otlp:<trace id>`). */
  turnId: string;
  at: Date;
  text: string;
  /** The trace the turn's model calls belong to; null when the SDK sent none. */
  traceId: string | null;
}

export interface ModelReadContext {
  /** The run's window. */
  range: { from: Date; to: Date };
  /** A session's turns are one person's, in order: neighbours may be read. */
  sessions: boolean;
  /**
   * The agent's reply in the turn after each turn, by turn id, where the
   * project captures replies: the reply question reads it for a turn whose
   * person's message was not sent (`reply-reading.ts`).
   */
  nextReplies?: ReadonlyMap<string, string>;
}

export interface ModelReadDeps {
  ask: AskDeps;
  /** Every message of these sessions sent in `range`, with some margin on both sides. */
  loadMessages: (
    projectId: string,
    sessionIds: readonly string[],
    range: { from: Date; to: Date },
  ) => Promise<readonly SessionMessage[]>;
  /** The agent's final reply of each of these traces, where content was captured. */
  loadReplies: (
    projectId: string,
    traceIds: readonly string[],
  ) => Promise<ReadonlyMap<string, string>>;
  /** The query text of these search events, by event id. */
  loadQueries: (
    projectId: string,
    eventIds: readonly string[],
  ) => Promise<ReadonlyMap<string, string>>;
}

/** What a run stores about its questions (`trace_signal_runs.summary.outcomes.questions`). Counts only. */
export interface StoredQuestions {
  /** The questions' version (`OUTCOME_QUESTION_VERSION`). */
  version: number;
  /** Turns read whose message the project sent. */
  turnsWithText: number;
  /** Turns with at least one answer, cached or fresh. */
  turnsAnswered: number;
  /** Distinct questions asked and answered in this run. */
  fresh: number;
  /** Distinct questions answered from the cache. */
  cached: number;
  /** Distinct questions left for a later run by the cap or the clock. */
  capped: number;
  failed: number;
  /** HTTP calls made. */
  calls: number;
  /** Input tokens billed for the fresh questions. */
  inputTokens: number;
  /** Why the asking stopped early, when it did: out of usage or unavailable, a refused key, or a refused request. */
  stopped: ClosedQuestionFailureReason | null;
  /** Tasks the task question was asked about (or read from the cache for) in this run. */
  tasksAsked?: number;
  /** Turns whose satisfaction the questions left open and the lexicon read from the person's next message. */
  satisfactionByLexicon?: number;
  /** Distinct machine-written messages left out as nobody's reaction. */
  templates?: number;
}

export interface ModelReadResult {
  /** One row per turn with an answer. */
  rows: TurnAnswerRow[];
  /** Every turn's answers, by turn id; a turn nothing was asked about is absent. */
  answers: Map<string, TurnAnswers>;
  /** The task question's answers, by task id (its first turn's id); a task not answered is absent. */
  tasks: Map<string, TaskVerdict>;
  /** The reply question's answers, by turn id: how the person took the turn, as the next reply shows it. */
  replyReactions: Map<string, ReplyReaction>;
  stored: StoredQuestions;
}

const DECLARED_PREFIX = "declared:";
export const OTLP_TURN_PREFIX = "otlp:";
const messageKey = (sessionId: string, turnId: string): string => `${sessionId}\u0000${turnId}`;

/** The id a turn's message is recorded under: the SDK scope's id, or the OTel run's own key; null for a turn with no message of its own. */
export function messageTurnId(turnKey: string | null): string | null {
  if (turnKey?.startsWith(DECLARED_PREFIX)) return turnKey.slice(DECLARED_PREFIX.length);
  if (turnKey?.startsWith(OTLP_TURN_PREFIX)) return turnKey;
  return null;
}

/**
 * The SDK's turn scopes' messages and the OTel runs' prompts as one list, in
 * time order. A project that sends both sends each message twice (the scope's
 * message, and the prompt of the model call in the same trace): the scope's
 * wins, and a prompt counts only for a trace with no scope message. Pure.
 */
export function mergeSessionMessages(
  scoped: readonly SessionMessage[],
  prompts: readonly SessionMessage[],
): SessionMessage[] {
  const traced = new Set(scoped.flatMap((message) => message.traceId ?? []));
  return [
    ...scoped,
    ...prompts.filter((prompt) => prompt.traceId === null || !traced.has(prompt.traceId)),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** Words a message opens with that mark it as a template when they recur. */
export const TEMPLATE_OPENING_WORDS = 6;
/** Distinct sessions an opening must recur in to be a template. */
export const TEMPLATE_MIN_SESSIONS = 3;

/**
 * A message's opening with what changes between copies of one template taken
 * out: links, quoted names ("The checker of milestone “…” failed it"), ids
 * and numbers ("Pull request #496 …", "RC-599").
 */
const openingOf = (text: string): string | null => {
  const words = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[“"«][^”"»]*[”"»]/g, " ")
    .replace(/\b[a-z]+-\d+\b|#?\d+/g, " ")
    .replace(/[^\p{L}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  return words.length >= TEMPLATE_OPENING_WORDS
    ? words.slice(0, TEMPLATE_OPENING_WORDS).join(" ")
    : null;
};

/** A message that opens with a bracketed tag ("[beluga] Kayra's agent replied …") is a tool's notice. */
const TAGGED_NOTICE = /^\s*\[[\p{L}\p{N}_ .-]{1,40}\]/u;

/**
 * A short check on progress ("how is it going", "is it done", "continue"):
 * the person is waiting, not pushing back on the reply before.
 */
const STATUS_CHECK =
  /^(?:(?:so|ok|okay|and|hey)[,\s]+)?(?:how(?:'s| is| are)\s+(?:it|the|things|training|progress|results)(?:\s+\w+){0,2}\s*going|how are the results|what(?:'s| is)\s+the\s+(?:status|situation|progress)|(?:is|are)\s+(?:it|they|training|the \w+)\s+(?:done|finished|ready|promising|completed)|when (?:is|will) it\s+(?:be\s+)?(?:gonna\s+)?(?:be\s+)?(?:done|finished|ready)|did (?:the )?progress stop|any (?:update|news|progress)|status|continue|keep going|go on|go ahead)\s*[?.!]*\s*$/i;

export function isStatusCheck(text: string): boolean {
  const flat = text
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .trim();
  return flat.split(/\s+/).length <= 9 && STATUS_CHECK.test(flat);
}

/**
 * The messages that are machine-written, by text: a tagged notice, or one
 * whose first `TEMPLATE_OPENING_WORDS` words (links, quoted names and ids
 * left out) open messages in at least `TEMPLATE_MIN_SESSIONS` sessions. People do not open messages the same way
 * across sessions; an orchestrator's templates ("You stopped before handing
 * off …", "The checker of milestone … failed it") do. Pure.
 */
export function templateMessages(
  messages: readonly Pick<SessionMessage, "sessionId" | "text">[],
): Set<string> {
  const sessions = new Map<string, Set<string>>();
  for (const message of messages) {
    const opening = openingOf(message.text);
    if (opening === null) continue;
    sessions.set(opening, (sessions.get(opening) ?? new Set()).add(message.sessionId));
  }
  const out = new Set<string>();
  for (const message of messages) {
    const opening = openingOf(message.text);
    if (
      TAGGED_NOTICE.test(message.text) ||
      (opening !== null && (sessions.get(opening)?.size ?? 0) >= TEMPLATE_MIN_SESSIONS)
    )
      out.add(message.text);
  }
  return out;
}

/**
 * How a person took a turn, as the Topics lexicon reads their next message:
 * thanks reads satisfied, a complaint unsatisfied; a plain message is no
 * reading at all (a new request says nothing about the last reply).
 */
export function satisfactionByLexicon(next: string | null): "satisfied" | "unsatisfied" | null {
  if (next === null) return null;
  const sentiment = lexiconSentiment(next, { weak: false });
  return sentiment === "positive" ? "satisfied" : sentiment === "negative" ? "unsatisfied" : null;
}

/** Whether the questions are on: a key is set and the cap leaves room. */
export const modelLayerOn = (deps: Pick<ModelReadDeps, "ask">): boolean =>
  deps.ask.client !== null && deps.ask.maxAsks > 0 && deps.ask.maxTokens > 0;

/**
 * The turns as the questions read them. Pure: the loaded text in, one
 * `QuestionTurn` per turn out, in the order given.
 */
export function questionTurns(
  turns: readonly ModelTurn[],
  messages: readonly SessionMessage[],
  replies: ReadonlyMap<string, string>,
  queries: ReadonlyMap<string, string>,
  range: { from: Date; to: Date },
): QuestionTurn[] {
  const bySession = new Map<string, SessionMessage[]>();
  for (const message of messages)
    bySession.set(message.sessionId, [...(bySession.get(message.sessionId) ?? []), message]);
  const position = new Map<string, { list: SessionMessage[]; index: number }>();
  for (const list of bySession.values()) {
    list.sort((a, b) => a.at.getTime() - b.at.getTime());
    // A turn scope reports its start once; a repeat keeps the first.
    list.forEach((message, index) => {
      const key = messageKey(message.sessionId, message.turnId);
      if (!position.has(key)) position.set(key, { list, index });
    });
  }
  const turnOf = new Map<string, ModelTurn>();
  for (const turn of turns) {
    const id = messageTurnId(turn.turnKey);
    if (id !== null) turnOf.set(messageKey(turn.sessionId, id), turn);
  }
  // A reply is captured content: it is read only when the project captures any.
  const contentCapture = replies.size > 0;
  const replyOf = (message: SessionMessage): string | null =>
    replyToSend(message.traceId ? replies.get(message.traceId) : null, contentCapture);

  /** The exchange a message started, when it can be told whole: its calls are known, or it had none. */
  const exchangeOf = (message: SessionMessage): QuestionExchange | null => {
    const turn = turnOf.get(messageKey(message.sessionId, message.turnId));
    if (turn) return { request: message.text, calls: turn.calls, reply: replyOf(message) };
    // No turn among the ones read: inside the window that is a message with no call after it, before it the calls are not known.
    return message.at.getTime() >= range.from.getTime()
      ? { request: message.text, calls: [], reply: replyOf(message) }
      : null;
  };

  return turns.map((turn): QuestionTurn => {
    const unmetQueries = turn.unmetSearchEvents.flatMap((id) => queries.get(id) ?? []);
    const id = messageTurnId(turn.turnKey);
    const at = id !== null ? position.get(messageKey(turn.sessionId, id)) : undefined;
    const own = at?.list[at.index];
    if (!at || !own)
      return {
        turnId: turn.turnId,
        request: null,
        calls: turn.calls,
        reply: null,
        previous: null,
        next: null,
        unmetQueries,
      };
    const before = at.list[at.index - 1];
    return {
      turnId: turn.turnId,
      request: own.text,
      calls: turn.calls,
      reply: replyOf(own),
      previous: before ? exchangeOf(before) : null,
      next: at.list[at.index + 1]?.text ?? null,
      unmetQueries,
    };
  });
}

/**
 * The window's tasks with a goal in words, as the task question reads them.
 * Pure. Tasks are cut the way the fold cuts them (`segmentTasks`): by the
 * request gate's answers where the person's words were read, else one task
 * per turn with the turn's searches as its goal. A task whose goal has no
 * text here (its message, or its queries, were not loaded) is left out.
 * Without trusted sessions every turn is its own task.
 */
export function taskInputs(
  turns: readonly ModelTurn[],
  read: readonly QuestionTurn[],
  verdicts: ReadonlyMap<string, OutcomeVerdict>,
  queries: ReadonlyMap<string, string>,
  sessions: boolean,
): TaskQuestionInput[] {
  const readOf = new Map(read.map((turn) => [turn.turnId, turn]));
  const bySession = new Map<string, ModelTurn[]>();
  for (const turn of turns) {
    const key = sessions ? turn.sessionId : turn.turnId;
    bySession.set(key, [...(bySession.get(key) ?? []), turn]);
  }
  const out: TaskQuestionInput[] = [];
  for (const list of bySession.values()) {
    const rows = list.map((turn) => {
      const asks = readAnswers(turn.turnId, verdicts).asks;
      return {
        turnId: turn.turnId,
        startedAt: turn.startedAt,
        endedAt: turn.startedAt,
        okCalls: 0,
        failedCalls: 0,
        streaks: 0,
        unmetSearches: 0,
        request: asks === "yes" ? true : asks === "no" ? false : null,
        searches: turn.searchEvents.length,
      };
    });
    const byId = new Map(list.map((turn) => [turn.turnId, turn]));
    for (const task of segmentTasks(rows)) {
      const first = readOf.get(task.taskId);
      const own = byId.get(task.taskId);
      if (!first || !own) continue;
      const exchanges: TaskExchange[] = task.turnIds.map((turnId, i) => {
        const turn = readOf.get(turnId);
        return {
          message: i === 0 ? null : (turn?.request ?? null),
          calls: turn?.calls ?? [],
          reply: turn?.reply ?? null,
        };
      });
      const next = readOf.get(task.turnIds.at(-1)!)?.next ?? null;
      if (task.goalSource === "request" && first.request) {
        out.push({
          taskId: task.taskId,
          goal: { source: "request", text: first.request },
          exchanges,
          next,
        });
      } else if (task.goalSource === "search") {
        const goalQueries = own.searchEvents.flatMap((id) => queries.get(id) ?? []);
        if (goalQueries.length > 0)
          out.push({
            taskId: task.taskId,
            goal: { source: "search", queries: goalQueries },
            exchanges,
            next: null,
          });
      }
    }
  }
  return out;
}

/**
 * Read the model layer for the window's turns: load their text, ask what the
 * cache does not hold, under the cap, and read the answers into rows. Null
 * when the questions are off: the reading stays rule-only and nothing is
 * loaded.
 */
export async function readModelLayer(
  projectId: string,
  turns: readonly ModelTurn[],
  context: ModelReadContext,
  deps: ModelReadDeps,
): Promise<ModelReadResult | null> {
  if (!modelLayerOn(deps)) return null;
  const worded = context.sessions
    ? turns.filter((turn) => messageTurnId(turn.turnKey) !== null)
    : [];
  const messages =
    worded.length > 0
      ? await deps.loadMessages(
          projectId,
          [...new Set(worded.map((turn) => turn.sessionId))],
          context.range,
        )
      : [];
  const traces = [...new Set(messages.flatMap((message) => message.traceId ?? []))];
  const replies =
    traces.length > 0 ? await deps.loadReplies(projectId, traces) : new Map<string, string>();
  // The unmet runs' queries, and every search of a turn without the person's words: a trace-only task's goal.
  const withText = new Set(
    messages.map((message) => messageKey(message.sessionId, message.turnId)),
  );
  const textless = turns.filter((turn) => {
    const id = messageTurnId(turn.turnKey);
    return !(id !== null && withText.has(messageKey(turn.sessionId, id)));
  });
  const searches = [
    ...new Set([
      ...turns.flatMap((turn) => turn.unmetSearchEvents),
      ...textless.flatMap((turn) => turn.searchEvents),
    ]),
  ];
  const queries =
    searches.length > 0 ? await deps.loadQueries(projectId, searches) : new Map<string, string>();

  // Machine-written messages are no person's words: not a turn's request, not the reaction to the turn before.
  const templates = templateMessages(messages);
  const read = questionTurns(turns, messages, replies, queries, context.range).map((turn) => ({
    ...turn,
    request: turn.request !== null && templates.has(turn.request) ? null : turn.request,
    next: turn.next !== null && templates.has(turn.next) ? null : turn.next,
  }));
  const ruleOf = new Map(turns.map((turn) => [turn.turnId, turn.rule]));
  const none: QuestionRuleFacts = { failedCalls: 0, unmetSearches: 0, cause: null };

  // A turn whose person's message was not sent: what the next reply shows about it.
  const replyAsks = read.flatMap((turn) => {
    const next = turn.request === null ? context.nextReplies?.get(turn.turnId) : undefined;
    return next ? [replyAsk(turn.turnId, turn.calls, next)] : [];
  });
  const first = await askQuestions(
    projectId,
    [...read.flatMap((turn) => turnAsks(turn, ruleOf.get(turn.turnId) ?? none)), ...replyAsks],
    deps.ask,
  );
  const verdicts = new Map<string, OutcomeVerdict>(first.verdicts);

  // The second pass: why, for the turns the first pass says went wrong. What is left of the cap is its cap:
  // every question the first pass sent counts, answered or not (a question the server could not answer was still asked).
  const causes = read.flatMap(
    (turn) =>
      causeAsk(turn, ruleOf.get(turn.turnId) ?? none, readAnswers(turn.turnId, verdicts)) ?? [],
  );
  const second =
    causes.length > 0 && first.stopped === null
      ? await askQuestions(projectId, causes, {
          ...deps.ask,
          maxAsks: deps.ask.maxAsks - (first.fresh + first.failed),
          maxTokens: deps.ask.maxTokens - first.estimatedTokens,
        })
      : null;
  for (const [key, verdict] of second?.verdicts ?? []) verdicts.set(key, verdict);

  // The third pass: did each task's work achieve its goal. Under what is left of the same cap.
  const spent = first.fresh + first.failed + (second ? second.fresh + second.failed : 0);
  const spentTokens = first.estimatedTokens + (second?.estimatedTokens ?? 0);
  const stoppedSoFar = second?.stopped ?? first.stopped;
  const tasks = taskInputs(turns, read, verdicts, queries, context.sessions);
  const third =
    tasks.length > 0 && stoppedSoFar === null
      ? await askQuestions(projectId, tasks.map(taskAsk), {
          ...deps.ask,
          maxAsks: deps.ask.maxAsks - spent,
          maxTokens: deps.ask.maxTokens - spentTokens,
        })
      : null;
  const taskVerdicts = new Map<string, TaskVerdict>();
  for (const task of tasks) {
    const verdict = taskVerdictOf(third?.verdicts.get(taskAskKey(task.taskId)));
    if (verdict) taskVerdicts.set(task.taskId, verdict);
  }

  const replyReactions = new Map<string, ReplyReaction>();
  for (const ask of replyAsks) {
    const turnId = ask.key.slice(0, ask.key.length - replyAskKey("").length);
    const reaction = replyReactionOf(verdicts.get(ask.key));
    if (reaction) replyReactions.set(turnId, reaction);
  }
  // The model's answers feed the fusion; the rows also carry the lexicon's reading where the questions left satisfaction open.
  const answers = new Map<string, TurnAnswers>();
  const rows: TurnAnswerRow[] = [];
  let byLexicon = 0;
  for (const turn of read) {
    const turnAnswers = readAnswers(turn.turnId, verdicts);
    if (answered(turnAnswers)) answers.set(turn.turnId, turnAnswers);
    const bySage = satisfactionOf(turnAnswers);
    const lexicon =
      bySage !== "satisfied" && bySage !== "unsatisfied" ? satisfactionByLexicon(turn.next) : null;
    if (turn.next !== null && isStatusCheck(turn.next)) {
      // Asking how it is going is waiting, not pushing back, whatever the reaction question read in it.
      rows.push({ ...answerRow(turn.turnId, turnAnswers), satisfaction: "neutral" });
    } else if (lexicon) {
      byLexicon += 1;
      rows.push({ ...answerRow(turn.turnId, turnAnswers), satisfaction: lexicon });
    } else if (answered(turnAnswers)) {
      rows.push(answerRow(turn.turnId, turnAnswers));
    } else if (turn.next !== null) {
      // The person wrote again and nothing says they pushed back: they moved on.
      rows.push({ ...answerRow(turn.turnId, turnAnswers), satisfaction: "neutral" });
    }
  }
  const sum = (pick: (result: NonNullable<typeof second>) => number): number =>
    pick(first) + (second ? pick(second) : 0) + (third ? pick(third) : 0);
  return {
    rows,
    answers,
    tasks: taskVerdicts,
    replyReactions,
    stored: {
      version: OUTCOME_QUESTION_VERSION,
      turnsWithText: read.filter((turn) => turn.request !== null).length,
      turnsAnswered: answers.size,
      fresh: sum((result) => result.fresh),
      cached: sum((result) => result.cached),
      // Cause and task questions a stop kept from being asked wait too.
      capped:
        sum((result) => result.capped) + (second ? 0 : causes.length) + (third ? 0 : tasks.length),
      failed: sum((result) => result.failed),
      calls: sum((result) => result.calls),
      inputTokens: sum((result) => result.inputTokens),
      stopped: third?.stopped ?? stoppedSoFar,
      tasksAsked: taskVerdicts.size,
      satisfactionByLexicon: byLexicon,
      templates: templates.size,
    },
  };
}

/** A turn's answers, or none. */
export const answersOf = (result: ModelReadResult | null, turnId: string): TurnAnswers =>
  result?.answers.get(turnId) ?? NO_ANSWERS;
