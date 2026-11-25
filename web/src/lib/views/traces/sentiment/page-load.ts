import { type Config, getConfig } from "@/config";
import { composition } from "@/lib/composition/ports";
import type { ClosedQuestionsPort } from "@/lib/contracts/closed-questions";
import { getDb } from "@/lib/platform/db/client";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import type { WindowDays } from "@/lib/readings/trace-signals/view";
import {
  buildSentimentPage,
  type SentimentPageInput,
  type SentimentPageModel,
  type TaskFriction,
} from "@/lib/views/traces/sentiment/page-model";
import type { SentimentQuery } from "@/lib/views/traces/sentiment/page-paths";
import {
  countTextTurns,
  hasCostedModelCalls,
  loadFailedCalls,
  loadPageSessions,
  loadPageTasks,
  loadPageTurns,
  loadSatisfactionAnswers,
  loadTurnIntents,
  loadTurnTimes,
  loadTurnTotals,
  loadTurnUsage,
  type PageDb,
} from "@/lib/views/traces/sentiment/page-queries";
import { loadUnmetSearches, withUnmetSearches } from "@/lib/views/traces/sentiment/unmet-search";

/**
 * The Sentiment analysis page for one project and window: the stored outcome
 * rows, each turn's intent, and whether the person's words are there to read,
 * built into the page (`page-model.ts`).
 */

/** An intent with fewer answers than this is ranked but marked as a hint (`traceOutcomes.minSessions`). */
export function sentimentMinSessions(config: Pick<Config, "traceOutcomes"> = getConfig()): number {
  return config.traceOutcomes.minSessions;
}

/** Whether the model that reads the person's words can be asked: an edition's question engine, configured. */
export function outcomeModelConfigured(
  port: ClosedQuestionsPort | undefined = composition.closedQuestions,
): boolean {
  return port?.configured() ?? false;
}

const DAY_MS = 86_400_000;

export interface LoadSentimentPageOptions {
  projectId: string;
  windowDays: WindowDays;
  query: SentimentQuery;
  now?: Date;
  db?: PageDb;
  modelConfigured?: boolean;
  minSessions?: number;
}

/** Everything the page model reads, for one project and window. */
export async function readSentimentPageInput(
  options: Omit<LoadSentimentPageOptions, "query">,
): Promise<SentimentPageInput> {
  const now = options.now ?? new Date();
  const db = options.db ?? getDb();
  const window = { from: new Date(now.getTime() - options.windowDays * DAY_MS), to: now };
  const [turns, sessions, totals, text, costKnown, answers, tasks] = await Promise.all([
    loadPageTurns(options.projectId, window, db),
    loadPageSessions(options.projectId, window, db),
    loadTurnTotals(options.projectId, window, db),
    countTextTurns(options.projectId, window, db),
    hasCostedModelCalls(options.projectId, window, db),
    loadSatisfactionAnswers(options.projectId, window, db),
    loadPageTasks(options.projectId, window, db),
  ]);
  const turnIds = turns.turns.map((turn) => turn.turnId);
  // The tasks the root causes are counted over: not completed, or completed after friction. Their cost is their turns'.
  const explained = tasks.tasks.filter(
    (task) => task.result === "not_completed" || task.result === "completed_after_friction",
  );
  const frictionTurnIds = explained
    .filter((task) => task.result === "completed_after_friction")
    .flatMap((task) => task.turnIds);
  const [intents, usage, times, failedCalls] = await Promise.all([
    // One intent lookup for the turns with something to explain, the turns the person said how it went, and each task's first turn.
    loadTurnIntents(
      options.projectId,
      [
        ...turnIds,
        ...answers.answers.map((answer) => answer.turnId),
        ...tasks.tasks.map((task) => task.taskId),
      ],
      db,
    ),
    loadTurnUsage(
      options.projectId,
      [...turnIds, ...explained.flatMap((task) => task.turnIds)],
      db,
    ),
    loadTurnTimes(options.projectId, frictionTurnIds, db),
    loadFailedCalls(options.projectId, frictionTurnIds, db),
  ]);
  const costs = new Map(
    [...usage]
      .filter(([, used]) => costKnown && used.costUsd !== null)
      .map(([turnId, used]) => [turnId, used.costUsd!]),
  );
  const tokens = new Map([...usage].map(([turnId, used]) => [turnId, used.tokens]));
  return {
    projectId: options.projectId,
    windowDays: options.windowDays,
    now,
    turns: turns.turns.map((turn) => ({ ...turn, costUsd: costs.get(turn.turnId) ?? null })),
    sessions: sessions.sessions,
    answers: answers.answers,
    tasks: tasks.tasks.map((task) => ({
      ...task,
      costUsd: costOfTurns(task.turnIds, costs),
      tokens: costOfTurns(task.turnIds, tokens),
      friction:
        task.result === "completed_after_friction"
          ? frictionOf(task.turnIds, costs, tokens, times, failedCalls, costKnown)
          : null,
    })),
    intents,
    totals: { ...totals, textTurns: text.turns, messages: text.messages },
    modelConfigured: options.modelConfigured ?? outcomeModelConfigured(),
    costKnown,
    capped: turns.capped || sessions.capped || answers.capped || tasks.capped,
    minSessions: options.minSessions ?? sentimentMinSessions(),
  };
}

/**
 * What a task completed after friction spent on it: its turns but the last
 * (by start), whole; and in the last turn, the calls that failed before one
 * worked. A failed call's time is its own and the wait after it; its cost is
 * an estimate, its share of the turn's model calls (one per call, and the
 * reply).
 */
function frictionOf(
  turnIds: readonly string[],
  costs: ReadonlyMap<string, number>,
  tokens: ReadonlyMap<string, number>,
  times: ReadonlyMap<string, { startedAt: Date; endedAt: Date }>,
  failedCalls: ReadonlyMap<string, { failed: number; calls: number; wastedMs: number }>,
  costKnown: boolean,
): TaskFriction {
  const ordered = [...turnIds].sort(
    (a, b) => (times.get(a)?.startedAt.getTime() ?? 0) - (times.get(b)?.startedAt.getTime() ?? 0),
  );
  const extra = ordered.slice(0, -1);
  const last = ordered.at(-1);
  const failed = last ? failedCalls.get(last) : undefined;
  const retried = failed?.failed ?? 0;
  // A failed call's share of the last turn's model calls (one per call, and the reply).
  const shareOfLast = (byTurn: ReadonlyMap<string, number>) =>
    last && failed && failed.calls > 0
      ? ((byTurn.get(last) ?? 0) * retried) / (failed.calls + 1)
      : 0;
  const extraTokens = costOfTurns(extra, tokens);
  const lastTokens = last ? tokens.get(last) : undefined;
  return {
    extraTurns: extra.length,
    retriedCalls: retried,
    costUsd: costKnown ? (costOfTurns(extra, costs) ?? 0) + shareOfLast(costs) : null,
    tokens:
      extraTokens === null && lastTokens === undefined
        ? null
        : (extraTokens ?? 0) + shareOfLast(tokens),
    timeMs:
      extra.reduce((sum, turnId) => {
        const time = times.get(turnId);
        return sum + (time ? Math.max(0, time.endedAt.getTime() - time.startedAt.getTime()) : 0);
      }, 0) + (failed?.wastedMs ?? 0),
  };
}

/** The cost of some turns; null when none of them has one. */
function costOfTurns(
  turnIds: readonly string[],
  costs: ReadonlyMap<string, number>,
): number | null {
  const known = turnIds
    .map((turnId) => costs.get(turnId))
    .filter((cost): cost is number => cost !== undefined);
  return known.length === 0 ? null : known.reduce((sum, cost) => sum + cost, 0);
}

export async function loadSentimentPage(
  options: LoadSentimentPageOptions,
): Promise<SentimentPageModel> {
  return buildSentimentPage(await readSentimentPageInput(options), options.query);
}

/** Root cause analysis: the page, with what was searched on the examples no tool fitted. */
export async function loadRootCauses(
  options: LoadSentimentPageOptions,
): Promise<SentimentPageModel> {
  const model = await loadSentimentPage(options);
  return loadOrFallback({
    operation: "sentiment_unmet_searches",
    distinctId: `project:${options.projectId}`,
    fallback: model,
    load: () =>
      withUnmetSearches(model, (turnIds) =>
        loadUnmetSearches(options.projectId, turnIds, options.db),
      ),
  });
}
