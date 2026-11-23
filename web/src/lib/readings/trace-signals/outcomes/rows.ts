import { type FailureStreak, leadingStreak } from "@/lib/readings/trace-signals/outcomes/followed";
import type {
  FailureFollowed,
  FusionSource,
  OutcomeCause,
  SessionOutcome,
  StoredFailureStreak,
} from "@/lib/readings/trace-signals/outcomes/kinds";
import type {
  SessionReading,
  TurnOutcomeReading,
} from "@/lib/readings/trace-signals/outcomes/read";

/**
 * One `trace_turn_outcomes` row as the rule layer writes it, minus its project
 * and version. Pure.
 *
 * A streak's cause is the most common cause among its failed calls, the
 * earlier one on a tie; null when none of their error messages could be read
 * (pruned, or never sent). The turn's own `cause` and `followed` are those of
 * its leading failure (`leadingStreak`).
 *
 * PRIVACY: causes arrive already sorted; no error message reaches a row.
 */
export interface TurnOutcomeRowDraft {
  turnId: string;
  sessionId: string;
  startedAt: Date;
  endedAt: Date;
  cause: OutcomeCause | null;
  followed: FailureFollowed | null;
  failures: StoredFailureStreak[];
  okCalls: number;
  failedCalls: number;
  /** Failed calls whose error message could not be read. */
  errorsUnread: number;
  unmetSearches: number;
  catalogListings: number;
}

/**
 * One `trace_session_outcomes` row, minus its project and version: the rule
 * layer's fold and the fusion's outcome with what it was decided from.
 */
export interface SessionOutcomeRowDraft extends SessionReading {
  sessionId: string;
  outcome?: SessionOutcome | null;
  outcomeSource?: FusionSource | null;
}

/** The turn a row belongs to, as much as a row needs. */
export interface RowTurn {
  id: string;
  sessionId: string;
  startedAt: Date;
  endedAt: Date;
}

/** The most common cause, the one seen first on a tie; null when there is none. */
export function commonCause(causes: readonly OutcomeCause[]): OutcomeCause | null {
  const counts = new Map<OutcomeCause, number>();
  for (const cause of causes) counts.set(cause, (counts.get(cause) ?? 0) + 1);
  let best: OutcomeCause | null = null;
  for (const [cause, n] of counts) if (best === null || n > (counts.get(best) ?? 0)) best = cause;
  return best;
}

function storedStreak(
  streak: FailureStreak,
  causeAt: ReadonlyMap<number, OutcomeCause>,
): StoredFailureStreak {
  const causes = streak.ordinals.flatMap((ordinal) => causeAt.get(ordinal) ?? []);
  return {
    tool: streak.tool,
    ordinal: streak.ordinals[0] ?? 0,
    errors: streak.ordinals.length,
    cause: commonCause(causes),
    followed: streak.followed,
    recovered: streak.recovered,
  };
}

/** One turn's row. `causeAt` is the cause of each failed call whose message was read, by step ordinal. */
export function turnOutcomeRow(
  turn: RowTurn,
  reading: TurnOutcomeReading,
  causeAt: ReadonlyMap<number, OutcomeCause>,
): TurnOutcomeRowDraft {
  const failures = reading.streaks.map((streak) => storedStreak(streak, causeAt));
  const leading = leadingStreak(failures);
  const read = reading.streaks.reduce(
    (total, streak) => total + streak.ordinals.filter((ordinal) => causeAt.has(ordinal)).length,
    0,
  );
  return {
    turnId: turn.id,
    sessionId: turn.sessionId,
    startedAt: turn.startedAt,
    endedAt: turn.endedAt,
    cause: leading?.cause ?? null,
    followed: leading?.followed ?? null,
    failures,
    okCalls: reading.okCalls,
    failedCalls: reading.failedCalls,
    errorsUnread: reading.failedCalls - read,
    unmetSearches: reading.unmetSearches,
    catalogListings: reading.catalogListings,
  };
}
