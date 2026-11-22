import { statsOfUseCase, type UseCaseStats } from "./domain/stats";
import { callMatches, selectorWindow, type UseCaseSelector } from "./domain/use-case";
import type { ModelCallSource } from "./ports/store";

/**
 * Resolve a use case to its turns and model calls (RC-1124): the closed
 * turns its tasks or intents matched in its window, each turn's traces, the
 * calls of those traces, then the call filter. A turn with no call left
 * still counts as a turn of the use case.
 */

/** The most turns one resolution reads; more and the result says `truncated`. */
export const MAX_RESOLVED_TURNS = 2_000;

export interface UseCaseCall {
  traceId: string | null;
  spanId: string | null;
  spanName: string | null;
  model: string | null;
  occurredAt: Date;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface ResolvedTurn {
  turnId: string;
  taskId: string | null;
  startedAt: Date;
  endedAt: Date;
  traceIds: string[];
  calls: UseCaseCall[];
}

export interface ResolvedUseCase {
  window: { since: Date; until: Date };
  turns: ResolvedTurn[];
  truncated: boolean;
}

export async function resolveUseCase(
  projectId: string,
  selector: UseCaseSelector,
  source: ModelCallSource,
  now: Date,
  limit: number = MAX_RESOLVED_TURNS,
): Promise<ResolvedUseCase> {
  const window = selectorWindow(selector, now);
  const matched = await source.findClosedTurns(projectId, {
    taskIds: selector.taskIds,
    intentIds: selector.intentIds,
    ...window,
    limit: limit + 1,
  });
  const truncated = matched.length > limit;
  const turns = matched.slice(0, limit);
  if (turns.length === 0) return { window, turns: [], truncated };

  const traces = await source.turnTraceIds(
    projectId,
    turns.map((turn) => turn.turnId),
  );
  const windows = turns.map((turn) => ({
    turnId: turn.turnId,
    startedAt: turn.startedAt,
    endedAt: turn.endedAt,
    traceIds: traces.get(turn.turnId) ?? [],
  }));
  const calls = await source.modelCalls(projectId, windows);
  const spans = [...calls.values()]
    .flat()
    .flatMap((call) =>
      call.traceId && call.spanId ? [{ traceId: call.traceId, spanId: call.spanId }] : [],
    );
  const names =
    spans.length > 0 ? await source.spanNames(projectId, spans) : new Map<string, string>();

  return {
    window,
    truncated,
    turns: turns.map((turn) => ({
      ...turn,
      traceIds: traces.get(turn.turnId) ?? [],
      calls: (calls.get(turn.turnId) ?? [])
        .map((call) => ({
          traceId: call.traceId ?? null,
          spanId: call.spanId ?? null,
          spanName:
            call.traceId && call.spanId
              ? (names.get(`${call.traceId}:${call.spanId}`) ?? null)
              : null,
          model: call.model,
          occurredAt: call.occurredAt,
          costUsd: call.costUsd,
          inputTokens: call.inputTokens,
          outputTokens: call.outputTokens,
        }))
        .filter((call) => callMatches(selector.callFilter, call)),
    })),
  };
}

/**
 * A use case's volume, current model and cost per run (RC-1125): the turn
 * totals over the whole window, and the calls of its newest
 * {@link MAX_RESOLVED_TURNS} turns.
 */
export async function loadUseCaseStats(
  projectId: string,
  selector: UseCaseSelector,
  source: ModelCallSource,
  now: Date,
): Promise<UseCaseStats> {
  const window = selectorWindow(selector, now);
  const [totals, resolved] = await Promise.all([
    source.turnTotals(projectId, {
      taskIds: selector.taskIds,
      intentIds: selector.intentIds,
      ...window,
    }),
    resolveUseCase(projectId, selector, source, now),
  ]);
  return statsOfUseCase(resolved.turns, totals);
}
