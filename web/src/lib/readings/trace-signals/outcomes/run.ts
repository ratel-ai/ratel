import type { ClosedTurnPage, listClosedTurnsPage } from "@/lib/ledger/closed-turns";
import { walkClosedTurnPages } from "@/lib/ledger/turn-pages";
import type { StepDraft } from "@/lib/ledger/types";
import { getLogger } from "@/lib/platform/logger";
import { reportServerException } from "@/lib/platform/telemetry";
import { nodeIdOf } from "@/lib/readings/tool-explorer/units";
import { createCauseTally, readError } from "@/lib/readings/trace-signals/outcomes/error-cause";
import { sessionOutcome, turnResult } from "@/lib/readings/trace-signals/outcomes/fusion";
import {
  FAILURE_FOLLOWED,
  type FailureFollowed,
  OUTCOME_RULE_VERSION,
  type OutcomeCause,
  SESSION_OUTCOMES,
  type SessionOutcome,
  TASK_RESULTS,
  type TaskResult,
  TURN_RESULTS,
  type TurnResult,
} from "@/lib/readings/trace-signals/outcomes/kinds";
import type {
  ModelReadContext,
  ModelReadResult,
  ModelTurn,
  StoredQuestions,
} from "@/lib/readings/trace-signals/outcomes/model-read";
import { NO_ANSWERS, type TurnAnswerRow } from "@/lib/readings/trace-signals/outcomes/questions";
import {
  inOrder,
  readSession,
  readTurnOutcome,
  type SessionTurn,
} from "@/lib/readings/trace-signals/outcomes/read";
import {
  type ReplyReaction,
  replyReactionByRule,
} from "@/lib/readings/trace-signals/outcomes/reply-reading";
import {
  type SessionOutcomeRowDraft,
  type TurnOutcomeRowDraft,
  turnOutcomeRow,
} from "@/lib/readings/trace-signals/outcomes/rows";
import type {
  ReplyReactionRow,
  TaskOutcomeRowDraft,
  TurnResultRow,
} from "@/lib/readings/trace-signals/outcomes/run-queries";
import { searchRuns } from "@/lib/readings/trace-signals/outcomes/search-runs";
import {
  segmentTasks,
  type TaskVerdict,
  taskOutcome,
} from "@/lib/readings/trace-signals/outcomes/tasks";
import {
  readsTurn,
  type SelfCorrectionTrust,
  trustOf,
} from "@/lib/readings/trace-signals/self-corrections/detect";
import type { SignalTurn } from "@/lib/readings/trace-signals/signals/types";
import type { RunBasis } from "@/lib/readings/trace-signals/workflows/run-basis";

/**
 * The outcome reading inside a signal run (`compute_trace_signals`): every
 * closed turn ending in the run's window, read under the run-boundary rules
 * the self-corrections use (`trustOf`), gives its failure streaks with what
 * followed each (`followed.ts`), the cause of each failed call from its error
 * message (`error-cause.ts`) and its search runs (`search-runs.ts`). The
 * window's `trace_turn_outcomes` rows are replaced with what was read, then
 * every session those turns belong to is folded again from all of its turn
 * rows (`readSession`), so a session that started before the window keeps its
 * first turn.
 *
 * Turns are walked a page at a time under the signal run's wall-clock budget
 * (a `TimeBudgetError` propagates). Nothing is written until the walk is
 * done, so a reading that runs out of time leaves the window's earlier rows
 * as they were.
 *
 * Then the fusion (`fusion.ts`), in code: every turn read gets its result
 * from its rule facts and its answers, and every session folded gets its
 * outcome from its turn rows. Every session folded is also cut into tasks
 * (`tasks.ts`), each with its result: the task question's answer where the
 * model layer gave one in this run, else the one stored with the task.
 *
 * The rule layer asks no model. When a Sage key is configured AND the
 * project's organization has Sentiment analysis on (`questions-gate.ts`), the
 * model layer (`model-read.ts`) then asks its closed questions about the same
 * turns, capped and cached, and its answers go on the rows the rules just
 * wrote. Without either, no text is loaded, no call is made and the rows are
 * rule-only; the summary says which was missing (`questionsOff`). The model
 * layer is best-effort: when it fails, the rule rows and the summary stand.
 *
 * REPLIES. Where the project captures the agent's replies, each turn's
 * reply is loaded after the walk and read for how the person took the turn
 * before it (`reply-reading.ts`): by rules always, and by the reply question
 * when the model layer is on, for turns whose person's message was not sent.
 * The answer goes on the turn's row as `reply_reaction`, and the session and
 * task folds read it where the person's own reaction is missing.
 *
 * PRIVACY: error messages are read a page at a time and sorted into a cause
 * in memory. With the model layer on, a clipped copy stays in memory until
 * the questions are built, then is dropped. Rows and the summary hold closed
 * values, counts, ids and times.
 */

const logger = getLogger("trace-signals/outcomes");

/** What a run stores in `trace_signal_runs.summary.outcomes`. Counts only. */
export interface StoredOutcomes {
  version: 1;
  ruleVersion: number;
  /** Which runs and sessions the reading trusted. */
  trust: SelfCorrectionTrust;
  /** Turn rows written: the turns read in the window. */
  turns: number;
  /** Session rows written: the sessions those turns belong to. Zero when sessions are not trusted. */
  sessions: number;
  failedCalls: number;
  /** Failed calls whose error message was gone or never sent: they have no cause. */
  errorsUnread: number;
  /** Failed calls by cause, every read one counted once. */
  causes: Record<OutcomeCause, number>;
  /** Distinct normalized messages no pattern knew. */
  otherShapes: number;
  streaks: number;
  /** Failure streaks by what followed them. */
  followed: Record<FailureFollowed, number>;
  unmetSearches: number;
  catalogListings: number;
  /** Sessions whose last turn asked for something and got no successful call. */
  openRequests: number;
  /** The fusion's counts for this run (`fusion.ts`). */
  fusion: StoredFusion;
  /** Tasks folded, by result (`tasks.ts`); absent when tasks are not stored. */
  tasks?: Record<TaskResult, number>;
  /** The model layer's questions in this run; absent when they did not run and the rows are rule-only. */
  questions?: StoredQuestions;
  /** Why the questions did not run; absent when they did. */
  questionsOff?: QuestionsOff;
}

/**
 * Why a reading asked no question: no configured Sage key (`no_key`), a cap
 * of zero (`cap_zero`), the organization's Sentiment analysis flag off
 * (`switch_off`), or the model layer failing before it answered (`failed`).
 */
export type QuestionsOff = "no_key" | "cap_zero" | "switch_off" | "failed";

/** What the fusion decided in a run. Counts only. */
export interface StoredFusion {
  /** Turns read, by result; a turn nothing is known about is in none. */
  results: Record<TurnResult, number>;
  /** Turns whose reply said done while the trace ended in an error. */
  falseCompletions: number;
  /** Sessions folded, by outcome. */
  sessions: Record<SessionOutcome, number>;
  /** Of those, the sessions decided from the trace alone: no answer about the person's text was part of it. */
  ruleOnlySessions: number;
}

export interface OutcomeRunDeps {
  listPage: typeof listClosedTurnsPage;
  /** The window's run basis (`run-basis.ts`), as the signal run decides it. */
  loadBasis: (projectId: string, window: { start: Date; end: Date }) => Promise<RunBasis>;
  /** The error messages of these `trace_events` ids, by id; an id is absent when its event is pruned or sent no message. */
  loadErrors: (
    projectId: string,
    eventIds: readonly string[],
  ) => Promise<ReadonlyMap<string, string>>;
  /** Replaces the rule layer's columns for the turns ending in `range`; returns the sessions whose turn rows changed. */
  replaceTurnRows: (
    projectId: string,
    range: { from: Date; to: Date },
    rows: readonly TurnOutcomeRowDraft[],
    at: Date,
  ) => Promise<{ written: number; sessions: string[] }>;
  /** Every stored turn row of these sessions, as the fold reads them, by session id. */
  loadSessionTurns: (
    projectId: string,
    sessionIds: readonly string[],
  ) => Promise<ReadonlyMap<string, readonly SessionTurn[]>>;
  /** Replaces the rule layer's columns for these sessions: a session with no row in `rows` loses its row. */
  replaceSessionRows: (
    projectId: string,
    sessionIds: readonly string[],
    rows: readonly SessionOutcomeRowDraft[],
    at: Date,
  ) => Promise<number>;
  /**
   * The model layer (`model-read.ts`): the window's turns in, their answers
   * out; null when the questions are off. Absent: the reading is rule-only.
   */
  readModel?: (
    projectId: string,
    turns: readonly ModelTurn[],
    context: ModelReadContext,
  ) => Promise<ModelReadResult | null>;
  /** Why `readModel` is absent, when it is; `no_key` when not said. */
  questionsOff?: Extract<QuestionsOff, "no_key" | "cap_zero">;
  /**
   * The switch of the questions: the Sentiment analysis flag of the project's
   * organization (`questions-gate.ts`). Asked once per reading, before the
   * walk, and only when `readModel` is there; off, or failing, means no text
   * is kept or loaded and no call is made. Absent: on.
   */
  questionsSwitch?: (projectId: string) => Promise<boolean>;
  /** Writes the fused result on the turns' rows. Absent: results are counted, not stored. */
  writeTurnResults?: (projectId: string, rows: readonly TurnResultRow[]) => Promise<void>;
  /** Writes the model layer's answers on the turns' rows. */
  writeTurnAnswers?: (projectId: string, rows: readonly TurnAnswerRow[]) => Promise<void>;
  /** The task question's stored answers of these sessions' tasks. Absent: none are reused. */
  loadTaskVerdicts?: (
    projectId: string,
    sessionIds: readonly string[],
  ) => Promise<ReadonlyMap<string, TaskVerdict>>;
  /** The agent's reply in each of these turns (turn id and its first steps' event ids), where content is captured. Absent: replies are not read. */
  loadReplyTexts?: (
    projectId: string,
    turns: ReadonlyArray<readonly [string, readonly string[]]>,
  ) => Promise<ReadonlyMap<string, string>>;
  /**
   * The reply in the turn scope after each of these turns (turn id, session id, first steps' event ids), where the
   * SDK reports scopes: a scope with no call still has the reply after the turn before it. A scoped turn with nothing
   * to read maps to "". Absent: only built turns are paired.
   */
  loadNextScopeReplies?: (
    projectId: string,
    turns: ReadonlyArray<readonly [string, string, readonly string[]]>,
  ) => Promise<ReadonlyMap<string, string>>;
  /** Writes each turn's reaction inferred from the next reply, or null. */
  writeReplyReactions?: (projectId: string, rows: readonly ReplyReactionRow[]) => Promise<void>;
  /** Replaces these sessions' task rows. Absent: tasks are not stored. */
  replaceTaskRows?: (
    projectId: string,
    sessionIds: readonly string[],
    rows: readonly TaskOutcomeRowDraft[],
    at: Date,
  ) => Promise<number>;
  now: () => Date;
  timeBudgetMs: number;
  /** Epoch ms the budget counts from: the job's start, so this shares the run's budget. */
  startedAt: number;
  pageSize: number;
}

export interface OutcomeRunInput {
  window: { start: Date; end: Date };
}

export interface OutcomeRunResult {
  stored: StoredOutcomes;
}

const failedCalls = (steps: readonly StepDraft[]): StepDraft[] =>
  steps.filter((step) => nodeIdOf(step) !== null && step.outcome === "error");

/** The event that carries a failed call's error: its end, or the call itself when it is one event. */
const errorEventOf = (step: StepDraft): string => step.endTraceEventId ?? step.traceEventId;

/** One turn as the model layer reads it: its calls with their outcome, and the searches of an unmet run that ends it. */
function modelTurn(
  turn: SignalTurn,
  row: TurnOutcomeRowDraft,
  messages: ReadonlyMap<string, string>,
): ModelTurn {
  const calls = turn.steps.flatMap((step) => {
    const tool = nodeIdOf(step);
    return tool === null
      ? []
      : [
          {
            tool,
            outcome: step.outcome ?? ("unknown" as const),
            error: step.outcome === "error" ? (messages.get(errorEventOf(step)) ?? null) : null,
          },
        ];
  });
  const unmet = searchRuns(turn.steps).findLast((run) => run.kind === "unmet");
  const unmetSearchEvents = unmet
    ? turn.steps
        .filter((step) => step.kind === "search" && step.ordinal >= unmet.ordinal)
        .map((step) => step.traceEventId)
    : [];
  return {
    turnId: turn.id,
    sessionId: turn.sessionId,
    startedAt: row.startedAt,
    searchEvents: turn.steps
      .filter((step) => step.kind === "search")
      .map((step) => step.traceEventId),
    turnKey: turn.turnKey ?? null,
    calls,
    unmetSearchEvents,
    rule: { failedCalls: row.failedCalls, unmetSearches: row.unmetSearches, cause: row.cause },
  };
}

/** Run one outcome reading for the window. Throws `TimeBudgetError` on overrun, before anything is written. */
export async function recordOutcomes(
  projectId: string,
  input: OutcomeRunInput,
  deps: OutcomeRunDeps,
): Promise<OutcomeRunResult> {
  const range = { from: input.window.start, to: input.window.end };
  const trust = trustOf(await deps.loadBasis(projectId, input.window));
  const rows: TurnOutcomeRowDraft[] = [];
  const tally = createCauseTally();
  // A key and the switch, both: decided before the walk, so a reading that will ask nothing keeps no text.
  let questionsOff: QuestionsOff | null = !deps.readModel
    ? (deps.questionsOff ?? "no_key")
    : (await switchedOn(projectId, deps))
      ? null
      : "switch_off";
  const readModel = questionsOff === null ? deps.readModel : undefined;
  // Kept only when the model layer will run: a rule-only reading holds no text past its page.
  const modelTurns: ModelTurn[] = [];
  // Each turn's first steps, to find its trace and the reply in it. Ids only.
  const stepEvents = new Map<string, string[]>();

  const readPage = async (turns: readonly SignalTurn[]) => {
    const events = turns.flatMap((turn) => failedCalls(turn.steps).map(errorEventOf));
    const messages =
      events.length > 0 ? await deps.loadErrors(projectId, events) : new Map<string, string>();
    for (const turn of turns) {
      const causeAt = new Map<number, OutcomeCause>();
      for (const step of failedCalls(turn.steps)) {
        const reading = readError(messages.get(errorEventOf(step)));
        if (!reading) continue;
        tally.add(reading);
        causeAt.set(step.ordinal, reading.cause);
      }
      const row = turnOutcomeRow(turn, readTurnOutcome(turn.steps), causeAt);
      rows.push(row);
      if (deps.loadReplyTexts)
        stepEvents.set(
          turn.id,
          turn.steps.slice(0, 3).map((step) => step.traceEventId),
        );
      if (readModel) modelTurns.push(modelTurn(turn, row, messages));
    }
  };

  if (trust.runs !== "none") {
    const walk = {
      pageSize: deps.pageSize,
      startedAt: deps.startedAt,
      now: deps.now,
      timeBudgetMs: deps.timeBudgetMs,
    };
    await walkClosedTurnPages(
      deps.listPage,
      projectId,
      range,
      walk,
      async (page: ClosedTurnPage) => {
        const read = page.turns.filter((turn) => readsTurn(trust, turn.turnSource));
        if (read.length > 0) await readPage(read);
      },
    );
  }

  const at = deps.now();
  const replaced = await deps.replaceTurnRows(projectId, range, rows, at);
  // The reply in the turn after each turn, in session order, where replies are captured and sessions are one person's.
  // Null when they could not be read: the reactions read before stay.
  const readReplies = trust.sessions
    ? await nextReplyByTurn(projectId, rows, stepEvents, deps)
    : new Map<string, string>();
  const nextReplies = readReplies ?? new Map<string, string>();
  const asked = await modelLayer(
    projectId,
    modelTurns,
    { range, sessions: trust.sessions, nextReplies },
    { readModel, writeTurnAnswers: deps.writeTurnAnswers },
  );
  const model = asked.model;
  if (asked.failed) questionsOff = "failed";
  // The fusion, turn by turn: the rule facts just read and the answers, where there are any.
  const fused = rows.map((row) => ({
    turnId: row.turnId,
    ...turnResult(row, model?.answers.get(row.turnId) ?? NO_ANSWERS),
  }));
  if (fused.length > 0)
    await deps.writeTurnResults?.(
      projectId,
      fused.map(({ turnId, result, source, cause }) => ({ turnId, result, source, cause })),
    );
  // How the person took each turn, from the next reply: the model's answer, else the rules'.
  if (deps.writeReplyReactions && deps.loadReplyTexts && readReplies) {
    const inferred = rows.map((row): ReplyReactionRow => {
      const byModel = model?.replyReactions.get(row.turnId) ?? null;
      const byRule: ReplyReaction | null = byModel
        ? null
        : replyReactionByRule(nextReplies.get(row.turnId));
      return {
        turnId: row.turnId,
        reaction: byModel ?? byRule,
        source: byModel ? "model" : byRule ? "rule" : null,
      };
    });
    await deps.writeReplyReactions(projectId, inferred);
  }
  // Sessions are folded only where a session's turns are one user's, in order.
  const turnsBySession =
    trust.sessions && replaced.sessions.length > 0
      ? await deps.loadSessionTurns(projectId, replaced.sessions)
      : new Map<string, readonly SessionTurn[]>();
  const sessionRows = [...turnsBySession].flatMap(
    ([sessionId, turns]): SessionOutcomeRowDraft[] => {
      const reading = readSession(turns);
      // The session's outcome, from every turn row it has: the ones just written and the older ones.
      // Where the person's own reaction is missing, what the next reply shows stands in for it; read by rules
      // alone, the outcome stays the rules' own.
      const fused = sessionOutcome(
        inOrder(turns).map((turn) => ({
          ...turn,
          reaction: turn.reaction ?? turn.replyReaction ?? null,
        })),
      );
      const answered = turns.some(
        (turn) =>
          turn.resultSource === "model" ||
          (turn.satisfaction ?? null) !== null ||
          (turn.reaction ?? null) !== null ||
          turn.replyReactionSource === "model",
      );
      const outcome = fused && !answered ? { ...fused, source: "rule" as const } : fused;
      return reading
        ? [
            {
              sessionId,
              ...reading,
              outcome: outcome?.outcome ?? null,
              outcomeSource: outcome?.source ?? null,
            },
          ]
        : [];
    },
  );
  const sessions = await deps.replaceSessionRows(projectId, replaced.sessions, sessionRows, at);

  // Tasks: every session folded, cut again from all of its turn rows. A session that lost its row
  // above (its turns are gone, or sessions are no longer trusted) loses its tasks with it.
  let taskCounts: Record<TaskResult, number> | undefined;
  if (deps.replaceTaskRows && replaced.sessions.length > 0) {
    const stored =
      (turnsBySession.size > 0
        ? await deps.loadTaskVerdicts?.(projectId, [...turnsBySession.keys()])
        : undefined) ?? new Map<string, TaskVerdict>();
    const taskRows = [...turnsBySession].flatMap(([sessionId, turns]) =>
      segmentTasks(turns).map((task): TaskOutcomeRowDraft => {
        const verdict = model?.tasks.get(task.taskId) ?? stored.get(task.taskId) ?? null;
        const outcome = taskOutcome(task, task.turns, verdict);
        return {
          taskId: task.taskId,
          sessionId,
          turnIds: task.turnIds,
          startedAt: task.startedAt,
          endedAt: task.endedAt,
          goalSource: task.goalSource,
          tier: outcome.tier,
          result: outcome.result,
          reason: outcome.reason,
          cause: outcome.cause,
          checked: outcome.checked,
          resultSource: outcome.source,
          answer: verdict && verdict.answer !== "unknown" ? verdict.answer : null,
          answerProbability: verdict?.probability ?? null,
        };
      }),
    );
    await deps.replaceTaskRows(projectId, replaced.sessions, taskRows, at);
    if (turnsBySession.size > 0) {
      const counts = Object.fromEntries(TASK_RESULTS.map((result) => [result, 0])) as Record<
        TaskResult,
        number
      >;
      for (const row of taskRows) counts[row.result as TaskResult] += 1;
      taskCounts = counts;
    }
  }

  const causes = tally.finish();
  const failed = rows.reduce((total, row) => total + row.failedCalls, 0);
  const followed = Object.fromEntries(FAILURE_FOLLOWED.map((kind) => [kind, 0])) as Record<
    FailureFollowed,
    number
  >;
  for (const row of rows) for (const streak of row.failures) followed[streak.followed] += 1;
  const results = Object.fromEntries(TURN_RESULTS.map((result) => [result, 0])) as Record<
    TurnResult,
    number
  >;
  for (const turn of fused) if (turn.result) results[turn.result] += 1;
  const outcomes = Object.fromEntries(SESSION_OUTCOMES.map((outcome) => [outcome, 0])) as Record<
    SessionOutcome,
    number
  >;
  for (const row of sessionRows) if (row.outcome) outcomes[row.outcome] += 1;
  return {
    stored: {
      version: 1,
      ruleVersion: OUTCOME_RULE_VERSION,
      trust,
      turns: replaced.written,
      sessions,
      failedCalls: failed,
      errorsUnread: rows.reduce((total, row) => total + row.errorsUnread, 0),
      causes: causes.byCause,
      otherShapes: causes.otherShapes,
      streaks: rows.reduce((total, row) => total + row.failures.length, 0),
      followed,
      unmetSearches: rows.reduce((total, row) => total + row.unmetSearches, 0),
      catalogListings: rows.reduce((total, row) => total + row.catalogListings, 0),
      openRequests: sessionRows.filter((row) => row.openRequest).length,
      fusion: {
        results,
        falseCompletions: fused.filter((turn) => turn.falseCompletion).length,
        sessions: outcomes,
        ruleOnlySessions: sessionRows.filter((row) => row.outcomeSource === "rule").length,
      },
      ...(taskCounts ? { tasks: taskCounts } : {}),
      ...(model ? { questions: model.stored } : {}),
      ...(questionsOff ? { questionsOff } : {}),
    },
  };
}

/** The questions' switch, asked once. A switch that cannot be read is off: asking is never the fallback. */
async function switchedOn(
  projectId: string,
  deps: Pick<OutcomeRunDeps, "questionsSwitch">,
): Promise<boolean> {
  if (!deps.questionsSwitch) return true;
  try {
    return await deps.questionsSwitch(projectId);
  } catch (err) {
    logger.error({ err, project_id: projectId }, "outcome questions switch failed");
    reportServerException(err, `project:${projectId}`, {
      operation: "trace_outcomes_questions_switch",
    });
    return false;
  }
}

/**
 * The model layer's answers for the window's turns, written on their rows;
 * no model when the questions are off or there is no turn to ask about, and
 * `failed` when the layer threw. Never throws: the rule rows are already
 * written and stand on their own.
 */
async function modelLayer(
  projectId: string,
  turns: readonly ModelTurn[],
  context: ModelReadContext,
  deps: Pick<OutcomeRunDeps, "readModel" | "writeTurnAnswers">,
): Promise<{ model: ModelReadResult | null; failed: boolean }> {
  if (!deps.readModel || turns.length === 0) return { model: null, failed: false };
  try {
    const model = await deps.readModel(projectId, turns, context);
    if (model && model.rows.length > 0) await deps.writeTurnAnswers?.(projectId, model.rows);
    return { model, failed: false };
  } catch (err) {
    logger.error({ err, project_id: projectId, turns: turns.length }, "outcome model layer failed");
    reportServerException(err, `project:${projectId}`, { operation: "trace_outcomes_model_layer" });
    return { model: null, failed: true };
  }
}

/**
 * The agent's reply in the turn after each turn of the window, by turn id:
 * turns of one session in order, each paired with the reply of the next. A
 * session's last turn has none. Empty when replies are not read or none was
 * captured, null when they could not be read. Never throws: replies are a
 * hint, and the rows stand without them.
 */
async function nextReplyByTurn(
  projectId: string,
  rows: readonly { turnId: string; sessionId: string; startedAt: Date }[],
  stepEvents: ReadonlyMap<string, string[]>,
  deps: Pick<OutcomeRunDeps, "loadReplyTexts" | "loadNextScopeReplies">,
): Promise<Map<string, string> | null> {
  const out = new Map<string, string>();
  if (!deps.loadReplyTexts || stepEvents.size === 0) return out;
  let replies: ReadonlyMap<string, string>;
  let byScope: ReadonlyMap<string, string>;
  try {
    const sessionOf = new Map(rows.map((row) => [row.turnId, row.sessionId]));
    // The next scope's reply first: it covers a "thanks" the agent answered with no call.
    byScope = deps.loadNextScopeReplies
      ? await deps.loadNextScopeReplies(
          projectId,
          [...stepEvents].map(
            ([turnId, ids]) => [turnId, sessionOf.get(turnId) ?? "", ids] as const,
          ),
        )
      : new Map<string, string>();
    replies = await deps.loadReplyTexts(
      projectId,
      [...stepEvents].filter(([turnId]) => !byScope.has(turnId)),
    );
  } catch (err) {
    logger.error({ err, project_id: projectId }, "outcome replies failed");
    reportServerException(err, `project:${projectId}`, { operation: "trace_outcomes_replies" });
    return null;
  }
  // "" marks a turn of a session that reports scopes but has nothing to read: no fallback pairing for it.
  for (const [turnId, reply] of byScope) if (reply) out.set(turnId, reply);
  if (replies.size === 0) return out;
  const bySession = new Map<string, Array<{ turnId: string; startedAt: Date }>>();
  for (const row of rows)
    bySession.set(row.sessionId, [...(bySession.get(row.sessionId) ?? []), row]);
  for (const turns of bySession.values()) {
    turns.sort(
      (a, b) => a.startedAt.getTime() - b.startedAt.getTime() || (a.turnId < b.turnId ? -1 : 1),
    );
    for (let i = 0; i + 1 < turns.length; i += 1) {
      if (out.has(turns[i]!.turnId)) continue;
      const reply = replies.get(turns[i + 1]!.turnId);
      if (reply) out.set(turns[i]!.turnId, reply);
    }
  }
  return out;
}
