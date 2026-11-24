import type { StepDraft } from "@/lib/ledger/types";
import { nodeIdOf } from "@/lib/readings/tool-explorer/units";
import { type FailureStreak, failureStreaks } from "@/lib/readings/trace-signals/outcomes/followed";
import {
  NO_SEARCH_CONTEXT,
  type SearchContext,
  unmetSearches,
} from "@/lib/readings/trace-signals/outcomes/search-fit";
import {
  SEARCH_RUN_MAX_SEARCHES,
  searchRuns,
} from "@/lib/readings/trace-signals/outcomes/search-runs";

/**
 * What the trace alone says about one turn, and about a session from its
 * turns. Pure: text-free steps in, counts and closed values out.
 *
 * A session's friction is every failure streak and every search run no listed
 * tool fits (`search-fit.ts`), over its turns. Its request is open when its
 * last turn asked for something and got no successful call: a call failed, or
 * no tool fit its search, and nothing in that turn worked. A last turn that
 * only searched or listed the catalog asked for nothing, and one whose calls
 * never reported an end cannot be told, so neither is an open request.
 */

export interface TurnOutcomeReading {
  okCalls: number;
  failedCalls: number;
  /** In step order. */
  streaks: FailureStreak[];
  /** Search runs no listed tool fits (`search-fit.ts`). */
  unmetSearches: number;
  catalogListings: number;
}

/** One turn read from its steps in ordinal order. */
export function readTurnOutcome(
  steps: readonly StepDraft[],
  context: SearchContext = NO_SEARCH_CONTEXT,
  maxSearches: number = SEARCH_RUN_MAX_SEARCHES,
): TurnOutcomeReading {
  const calls = steps.filter((step) => nodeIdOf(step) !== null);
  const runs = searchRuns(steps, maxSearches);
  return {
    okCalls: calls.filter((step) => step.outcome === "ok").length,
    failedCalls: calls.filter((step) => step.outcome === "error").length,
    streaks: failureStreaks(steps),
    unmetSearches: unmetSearches(steps, context, maxSearches).length,
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
  /** Calls the turn made, the ones that never reported an end included. */
  calls?: number;
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

/**
 * Whether a turn only searched: it made no call, every search of it listed
 * something that may fit, and nothing else was read of it. Listing tools is a
 * step towards work, not work: such a turn is no task and says nothing of how
 * its session went.
 */
export function searchedOnly(
  turn: Pick<SessionTurn, "okCalls" | "failedCalls" | "unmetSearches"> &
    Partial<
      Pick<
        SessionTurn,
        "searches" | "calls" | "request" | "result" | "satisfaction" | "reaction" | "replyReaction"
      >
    >,
): boolean {
  return (
    (turn.searches ?? 0) > 0 &&
    (turn.calls ?? 0) + turn.okCalls + turn.failedCalls === 0 &&
    turn.unmetSearches === 0 &&
    (turn.request ?? null) === null &&
    (turn.result ?? null) === null &&
    (turn.satisfaction ?? null) === null &&
    (turn.reaction ?? null) === null &&
    (turn.replyReaction ?? null) === null
  );
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
