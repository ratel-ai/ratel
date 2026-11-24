import { and, asc, eq, gt, inArray, isNotNull } from "drizzle-orm";
import { traceTurnSteps, traceTurns } from "@/lib/ledger/schema";
import type { getDb } from "@/lib/platform/db/client";
import type { TurnDetail } from "@/lib/views/traces/turn-detail";

/** A call made after a search. */
export interface CallAfterSearch {
  id: string;
  afterMs: number;
}

/** What the session ran after a turn that ended on a search. */
export interface AfterSearch {
  /** The turn's last search, by its call's ordinal. */
  ordinal: number;
  /** The next call; null when nothing more was run in the session. */
  next: CallAfterSearch | null;
  /** The first later call of a tool the search listed, when that is not the next call. */
  listed: CallAfterSearch | null;
}

type AfterSearchDb = Pick<ReturnType<typeof getDb>, "select">;

/** The search a turn ended on, when it ran nothing after it. */
export function endingSearch(turn: Pick<TurnDetail, "calls">): TurnDetail["calls"][number] | null {
  const last = turn.calls.at(-1);
  return last?.kind === "search" ? last : null;
}

export async function loadAfterSearch(
  db: AfterSearchDb,
  projectId: string,
  turn: Pick<TurnDetail, "sessionId" | "calls">,
): Promise<AfterSearch | null> {
  const search = endingSearch(turn);
  if (!search) return null;
  const at = new Date(search.occurredAt);
  const first = async (listed: readonly string[] | null): Promise<CallAfterSearch | null> => {
    const [call] = await db
      .select({ id: traceTurnSteps.targetId, at: traceTurnSteps.occurredAt })
      .from(traceTurnSteps)
      .innerJoin(traceTurns, eq(traceTurns.id, traceTurnSteps.turnId))
      .where(
        and(
          eq(traceTurns.projectId, projectId),
          eq(traceTurns.sessionId, turn.sessionId),
          eq(traceTurnSteps.projectId, projectId),
          eq(traceTurnSteps.kind, "invoke"),
          isNotNull(traceTurnSteps.targetId),
          gt(traceTurnSteps.occurredAt, at),
          listed ? inArray(traceTurnSteps.targetId, [...listed]) : undefined,
        ),
      )
      .orderBy(asc(traceTurnSteps.occurredAt), asc(traceTurnSteps.ordinal))
      .limit(1);
    return call?.id ? { id: call.id, afterMs: call.at.getTime() - at.getTime() } : null;
  };
  const listed = search.hits.map((hit) => hit.id);
  const next = await first(null);
  return {
    ordinal: search.ordinal,
    next,
    listed: next && listed.length > 0 && !listed.includes(next.id) ? await first(listed) : null,
  };
}
