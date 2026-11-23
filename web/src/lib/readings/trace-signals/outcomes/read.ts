import type { StepDraft } from "@/lib/ledger/types";
import { nodeIdOf } from "@/lib/readings/tool-explorer/units";
import { type FailureStreak, failureStreaks } from "@/lib/readings/trace-signals/outcomes/followed";
import {
  SEARCH_RUN_MAX_SEARCHES,
  searchRuns,
} from "@/lib/readings/trace-signals/outcomes/search-runs";

/**
 * What the trace alone says about one turn, and about a session from its
 * turns. Pure: text-free steps in, counts and closed values out.
 *
 * A session's friction is every failure streak and every search run nothing
 * was run for, over its turns. Its request is open when its last turn asked
 * for something and got no successful call: a call failed, or a search run
 * was left unmet, and nothing in that turn worked. A last turn that only
 * listed the catalog asked for nothing, and one whose calls never reported
 * an end cannot be told, so neither is an open request.
 */

export interface TurnOutcomeReading {
  okCalls: number;
  failedCalls: number;
  /** In step order. */
  streaks: FailureStreak[];
  /** Search runs with no call after them (`search-runs.ts`). */
  unmetSearches: number;
  catalogListings: number;
}

/** One turn read from its steps in ordinal order. */
export function readTurnOutcome(
  steps: readonly StepDraft[],
  maxSearches: number = SEARCH_RUN_MAX_SEARCHES,
): TurnOutcomeReading {
  const calls = steps.filter((step) => nodeIdOf(step) !== null);
  const runs = searchRuns(steps, maxSearches);
  return {
    okCalls: calls.filter((step) => step.outcome === "ok").length,
    failedCalls: calls.filter((step) => step.outcome === "error").length,
    streaks: failureStreaks(steps),
    unmetSearches: runs.filter((run) => run.kind === "unmet").length,
    catalogListings: runs.filter((run) => run.kind === "catalog_listing").length,
  };
}

/** One turn as a session's fold reads it: what `trace_turn_outcomes` keeps of it. */
export interface SessionTurn {
  turnId: string;
  startedAt: Date;
  endedAt: Date;
  okCalls: number;
  failedCalls: number;
  /** Failure streaks in the turn. */
  streaks: number;
  unmetSearches: number;
  catalogListings: number;
  /** What the other layers keep on the row, for the session's outcome (`fusion.ts`); absent in a rule-only fold. */
  result?: string | null;
  resultSource?: string | null;
  satisfaction?: string | null;
  reaction?: string | null;
  cause?: string | null;
  /** The model read the person's message as a request, not one, or did not read it (null): where tasks start (`tasks.ts`). */
  request?: boolean | null;
  /** Searches the turn ran: a trace-only task's goal. */
  searches?: number;
  /** How the person took the turn as the agent's next reply shows it, where their own message was not read. */
  replyReaction?: string | null;
  /** Whether a rule or the model read `replyReaction`. */
  replyReactionSource?: string | null;
}

export interface SessionReading {
  turnCount: number;
  /** Failure streaks plus unmet search runs, over the session's turns. */
  frictionCount: number;
  firstTurnId: string;
  lastTurnId: string;
  startedAt: Date;
  endedAt: Date;
  /** The last turn asked for something and got no successful call. */
  openRequest: boolean;
  unmetSearches: number;
  catalogListings: number;
}

/** Whether a turn asked for something and no call in it worked. */
export function leftOpen(
  turn: Pick<SessionTurn, "okCalls" | "failedCalls" | "unmetSearches">,
): boolean {
  return turn.okCalls === 0 && (turn.failedCalls > 0 || turn.unmetSearches > 0);
}

const byStart = (a: SessionTurn, b: SessionTurn): number =>
  a.startedAt.getTime() - b.startedAt.getTime() ||
  (a.turnId < b.turnId ? -1 : a.turnId > b.turnId ? 1 : 0);

/** A session's turns, oldest first. */
export const inOrder = (turns: readonly SessionTurn[]): SessionTurn[] => [...turns].sort(byStart);

/** One session folded from its turns, in any order; null when it has none. */
export function readSession(turns: readonly SessionTurn[]): SessionReading | null {
  const ordered = inOrder(turns);
  const first = ordered[0];
  const last = ordered.at(-1);
  if (!first || !last) return null;
  const sum = (pick: (turn: SessionTurn) => number) =>
    ordered.reduce((total, turn) => total + pick(turn), 0);
  const unmetSearches = sum((turn) => turn.unmetSearches);
  return {
    turnCount: ordered.length,
    frictionCount: sum((turn) => turn.streaks) + unmetSearches,
    firstTurnId: first.turnId,
    lastTurnId: last.turnId,
    startedAt: first.startedAt,
    endedAt: new Date(Math.max(...ordered.map((turn) => turn.endedAt.getTime()))),
    openRequest: leftOpen(last),
    unmetSearches,
    catalogListings: sum((turn) => turn.catalogListings),
  };
}
