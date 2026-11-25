import { composition } from "@/lib/composition/ports";
import type { ClosedQuestionsPort } from "@/lib/contracts/closed-questions";
import { listClosedTurnsPage, TURN_PAGE_SIZE } from "@/lib/ledger/closed-turns";
import {
  type AskDeps,
  OUTCOME_MAX_ASK_TOKENS,
  OUTCOME_MAX_ASKS,
  outcomeReasoning,
} from "@/lib/readings/trace-signals/outcomes/ask";
import {
  loadOutcomeVerdicts,
  saveOutcomeVerdicts,
} from "@/lib/readings/trace-signals/outcomes/ask-queries";
import {
  type ModelReadDeps,
  mergeSessionMessages,
  modelLayerOn,
  readModelLayer,
} from "@/lib/readings/trace-signals/outcomes/model-read";
import { sentimentQuestionsEnabled } from "@/lib/readings/trace-signals/outcomes/questions-gate";
import {
  type OutcomeRunDeps,
  type OutcomeRunInput,
  type OutcomeRunResult,
  recordOutcomes,
} from "@/lib/readings/trace-signals/outcomes/run";
import {
  loadErrorMessages,
  loadLastCalls,
  loadSessionTurns,
  loadTaskVerdicts,
  replaceSessionOutcomes,
  replaceTaskOutcomes,
  replaceTurnOutcomes,
  writeReplyReactions,
  writeTurnAnswers,
  writeTurnResults,
} from "@/lib/readings/trace-signals/outcomes/run-queries";
import {
  loadNextScopeReplies,
  loadOtlpSessionPrompts,
  loadReplies,
  loadSearchQueries,
  loadSessionMessages,
  loadTurnReplies,
} from "@/lib/readings/trace-signals/outcomes/text-queries";
import { loadRunBasisCounts } from "@/lib/readings/trace-signals/signals/analysis-context";
import { chooseRunBasis } from "@/lib/readings/trace-signals/workflows/run-basis";

/** The run's clock: the reading shares the signal run's wall-clock budget. */
export interface OutcomeBudget {
  startedAt: number;
  now: () => Date;
  timeBudgetMs: number;
}

/** The feature the questions log on each `model_call` line. */
export const OUTCOME_QUESTIONS_FEATURE = "outcome_questions";

/**
 * The model layer's deps: the client of the edition's question engine
 * (`composition.closedQuestions`) when it is configured, the caps and the
 * answer cache. Without the port, or with one that has no key, the client is
 * null and the layer is off.
 */
export function modelReadDeps(
  projectId: string,
  budget: OutcomeBudget,
  port: ClosedQuestionsPort | undefined = composition.closedQuestions,
): ModelReadDeps {
  const ask: AskDeps = {
    client: port?.configured()
      ? port.client({ feature: OUTCOME_QUESTIONS_FEATURE, projectId })
      : null,
    loadVerdicts: (id, keys) => loadOutcomeVerdicts(id, keys),
    saveVerdicts: (id, model, rows) => saveOutcomeVerdicts(id, model, rows),
    maxAsks: OUTCOME_MAX_ASKS,
    maxTokens: OUTCOME_MAX_ASK_TOKENS,
    reasoning: outcomeReasoning(),
    outOfTime: () => budget.now().getTime() - budget.startedAt > budget.timeBudgetMs,
  };
  return {
    ask,
    loadMessages: async (id, sessionIds, range) =>
      mergeSessionMessages(
        await loadSessionMessages(id, sessionIds, range),
        await loadOtlpSessionPrompts(id, sessionIds, range),
      ),
    loadReplies: (id, traceIds) => loadReplies(id, traceIds),
    loadQueries: (id, eventIds) => loadSearchQueries(id, eventIds),
  };
}

/**
 * The reading's deps against the app database. The model layer is there only
 * with a configured key and room under the cap, and then behind its switch:
 * the Sentiment analysis flag of the project's organization.
 *
 * `model` replaces the model layer's deps (tests pass a fake client); null
 * turns the layer off whatever the environment says. `questionsSwitch`
 * replaces the flag.
 */
export function outcomeRunDeps(
  budget: OutcomeBudget,
  model?: ((projectId: string) => ModelReadDeps) | null,
  questionsSwitch: NonNullable<OutcomeRunDeps["questionsSwitch"]> = (projectId) =>
    sentimentQuestionsEnabled(projectId),
): OutcomeRunDeps {
  const modelDeps =
    model === undefined ? (projectId: string) => modelReadDeps(projectId, budget) : model;
  // Decided once per reading, before the walk: a reading with no key keeps no text and loads none.
  const probe = modelDeps?.("") ?? null;
  const on = probe !== null && modelLayerOn(probe);
  return {
    ...(modelDeps !== null && on
      ? {
          readModel: (projectId, turns, context) =>
            readModelLayer(projectId, turns, context, modelDeps(projectId)),
          writeTurnAnswers: (projectId, rows) => writeTurnAnswers(projectId, rows),
          questionsSwitch,
        }
      : {
          questionsOff:
            probe !== null && probe.ask.client !== null
              ? ("cap_zero" as const)
              : ("no_key" as const),
        }),
    listPage: listClosedTurnsPage,
    loadBasis: async (projectId, window) =>
      chooseRunBasis(await loadRunBasisCounts(projectId, window)),
    loadErrors: (projectId, eventIds) => loadErrorMessages(projectId, eventIds),
    loadSearchQueries: (projectId, eventIds) => loadSearchQueries(projectId, eventIds),
    loadLastCalls: (projectId, sessionIds) => loadLastCalls(projectId, sessionIds),
    replaceTurnRows: (projectId, range, rows, at) =>
      replaceTurnOutcomes(projectId, range, rows, at),
    loadSessionTurns: (projectId, sessionIds) => loadSessionTurns(projectId, sessionIds),
    replaceSessionRows: (projectId, sessionIds, rows, at) =>
      replaceSessionOutcomes(projectId, sessionIds, rows, at),
    writeTurnResults: (projectId, rows) => writeTurnResults(projectId, rows),
    loadTaskVerdicts: (projectId, sessionIds) => loadTaskVerdicts(projectId, sessionIds),
    replaceTaskRows: (projectId, sessionIds, rows, at) =>
      replaceTaskOutcomes(projectId, sessionIds, rows, at),
    loadReplyTexts: (projectId, turns) => loadTurnReplies(projectId, turns),
    loadNextScopeReplies: (projectId, turns) => loadNextScopeReplies(projectId, turns),
    writeReplyReactions: (projectId, rows) => writeReplyReactions(projectId, rows),
    pageSize: TURN_PAGE_SIZE,
    ...budget,
  };
}

/** One outcome reading of a signal run's window, against the app database. */
export function recordOutcomesForRun(
  projectId: string,
  input: OutcomeRunInput,
  budget: OutcomeBudget,
): Promise<OutcomeRunResult> {
  return recordOutcomes(projectId, input, outcomeRunDeps(budget));
}
