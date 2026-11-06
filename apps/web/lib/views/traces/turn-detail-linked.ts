import { and, asc, eq, gt } from "drizzle-orm";
import { traceTurns } from "@/lib/ledger/schema";
import { getDb } from "@/lib/platform/db/client";
import {
  assignModelCalls,
  type LinkTurn,
  linkedFactOf,
} from "@/lib/readings/trace-signals/signals/linked-runs";
import {
  loadLinkCandidates,
  loadRunTraces,
  MAX_LINK_ROWS,
} from "@/lib/readings/trace-signals/signals/linked-runs-query";
import type { TurnLinked } from "@/lib/views/traces/turn-linked";

/**
 * What one SDK run gains on its Traces page when its agent also sends
 * OpenTelemetry with the same trace or session id: the model calls linked to it
 * (`signals/linked-runs.ts`), their cost and time, and the user's captured
 * ask, shown next to what the agent searched. Null for OTLP-lane turns and for
 * runs nothing linked to, so every other turn page is exactly as it was.
 */

export type { TurnLinked } from "@/lib/views/traces/turn-linked";

export type TurnLinkedDb = Pick<ReturnType<typeof getDb>, "select">;

export interface TurnLinkHead {
  id: string;
  sessionId: string;
  lane: string;
  startedAt: Date;
  endedAt: Date;
}

/** The session's next run, which bounds how far this run's model calls reach. */
async function nextRun(
  projectId: string,
  head: TurnLinkHead,
  db: TurnLinkedDb,
): Promise<LinkTurn | null> {
  const [next] = await db
    .select({
      id: traceTurns.id,
      sessionId: traceTurns.sessionId,
      startedAt: traceTurns.startedAt,
      endedAt: traceTurns.endedAt,
    })
    .from(traceTurns)
    .where(
      and(
        eq(traceTurns.projectId, projectId),
        eq(traceTurns.sessionId, head.sessionId),
        gt(traceTurns.startedAt, head.startedAt),
      ),
    )
    .orderBy(asc(traceTurns.startedAt), asc(traceTurns.id))
    .limit(1);
  return next ?? null;
}

/** The run's linked model calls and ask; null on the OTLP lane or when nothing links. */
export async function loadTurnLinked(
  projectId: string,
  head: TurnLinkHead,
  searched: string | null,
  db: TurnLinkedDb = getDb(),
): Promise<TurnLinked | null> {
  if (head.lane !== "runtime") return null;
  const runTraces = await loadRunTraces(projectId, [head.id], db);
  const traceIds = [...(runTraces.get(head.id) ?? [])];
  const candidates = await loadLinkCandidates(
    projectId,
    [{ ...head, lane: "runtime" }],
    db,
    MAX_LINK_ROWS,
    traceIds,
  );
  if (candidates.length === 0) return null;
  const next = await nextRun(projectId, head, db);
  const calls = assignModelCalls([head, ...(next ? [next] : [])], candidates, runTraces).get(
    head.id,
  );
  if (!calls || calls.length === 0) return null;
  const fact = linkedFactOf(calls);
  return {
    modelCalls: fact.modelCalls,
    inputTokens: fact.inputTokens,
    outputTokens: fact.outputTokens,
    costUsd: fact.costUsd,
    modelMs: fact.modelMs,
    asked: fact.prompt,
    searched,
  };
}
