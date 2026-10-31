import type { StepDraft } from "@/lib/ledger/types";
import { envNumber } from "@/lib/platform/env-number";
import type { ExplorerUnit } from "@/lib/readings/tool-explorer/types";
import type { SignalTurn } from "@/lib/readings/trace-signals/signals/types";

/**
 * Turns and sessions as the explorer counts them. Only invocations count; a
 * tool is its catalog id and a skill is `skill:<id>`, the node ids of Agent
 * health's flow map. Searches are left out: the explorer is about what the
 * agent ran, not what it was offered.
 */

/** Sessions kept in memory while folding; past it the newest sessions are dropped and the run says so. */
export const MAX_SESSIONS = Math.floor(envNumber("TOOL_EXPLORER_MAX_SESSIONS", 100_000));
/** Calls kept per session; a longer session is cut and the run says so. */
export const MAX_CALLS_PER_SESSION = Math.floor(
  envNumber("TOOL_EXPLORER_MAX_CALLS_PER_SESSION", 500),
);

/** The explorer's node id for an invoke step, or null for anything else. */
export function nodeIdOf(step: Pick<StepDraft, "kind" | "targetType" | "targetId">): string | null {
  if (step.kind !== "invoke" || step.targetId === null || step.targetType === null) return null;
  return step.targetType === "skill" ? `skill:${step.targetId}` : step.targetId;
}

/** Appends `id` unless it repeats the last call. */
function pushCollapsed(calls: string[], id: string): void {
  if (calls[calls.length - 1] !== id) calls.push(id);
}

export function sortedDistinct(calls: readonly string[]): string[] {
  return [...new Set(calls)].sort();
}

/** The ids a turn called, in order, repeats collapsed. */
export function callsOfTurn(turn: Pick<SignalTurn, "steps">): string[] {
  const calls: string[] = [];
  for (const step of turn.steps) {
    const id = nodeIdOf(step);
    if (id !== null) pushCollapsed(calls, id);
  }
  return calls;
}

export function unitOfTurn(turn: Pick<SignalTurn, "id" | "sessionId" | "steps">): ExplorerUnit {
  const calls = callsOfTurn(turn);
  return { id: turn.id, sessionId: turn.sessionId, calls, items: sortedDistinct(calls) };
}

export interface SessionFoldResult {
  units: ExplorerUnit[];
  /** True when a session was dropped or cut by the caps. */
  truncated: boolean;
}

/**
 * Folds turn units into session units, one per `sessionId`, calls concatenated
 * in the order given (the ledger pages turns by `ended_at`, so a session's
 * turns arrive in time order) with repeats across the turn boundary collapsed.
 * Turns with no calls still open their session, so a session of searches only
 * counts as a unit with no items, which the counts leave out.
 */
export function createSessionFold(
  limits = { maxSessions: MAX_SESSIONS, maxCalls: MAX_CALLS_PER_SESSION },
) {
  const sessions = new Map<string, string[]>();
  let truncated = false;
  return {
    add(turn: Pick<ExplorerUnit, "sessionId" | "calls">): void {
      let calls = sessions.get(turn.sessionId);
      if (!calls) {
        if (sessions.size >= limits.maxSessions) {
          truncated = true;
          return;
        }
        calls = [];
        sessions.set(turn.sessionId, calls);
      }
      for (const id of turn.calls) {
        if (calls.length >= limits.maxCalls) {
          truncated = true;
          return;
        }
        pushCollapsed(calls, id);
      }
    },
    finish(): SessionFoldResult {
      const units: ExplorerUnit[] = [];
      for (const [sessionId, calls] of sessions) {
        units.push({ id: sessionId, sessionId, calls, items: sortedDistinct(calls) });
      }
      return { units, truncated };
    },
    get size(): number {
      return sessions.size;
    },
  };
}
