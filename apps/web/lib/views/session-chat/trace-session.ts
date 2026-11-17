import { and, asc, eq } from "drizzle-orm";
import { traceEvents } from "@/lib/ingest/trace-events/schema";
import { traceTurnSteps, traceTurns } from "@/lib/ledger/schema";
import { getDb } from "@/lib/platform/db/client";
import { sessionPageTitle } from "@/lib/synthesis/traces/v2/run-noun";
import type { ReplayDb } from "@/lib/views/session-replay/load";
import { loadSessionChat } from "./load";
import { loadTurnTraceIds } from "./turn-traces";

/**
 * The session a turn's trace belongs to (RC-472): the
 * trace page links to the full session and keeps the session's turns on top,
 * each opening its own trace. An OTLP turn is its `otlp:<trace id>` run; a
 * runtime-lane turn is found through the trace's events in its steps.
 */

export interface TraceSessionTurn {
  turnIndex: number;
  /** The person's message, when the content opt-in is on and it was kept. */
  ask: string | null;
  /** The turn's first trace with spans; null when it has none. */
  traceId: string | null;
}

export interface TraceSession {
  sessionId: string;
  /** The session's first ask, else "Untitled session · <id>". */
  title: string;
  /** This trace's turn; null when the chat does not hold it (an open turn). */
  turnIndex: number | null;
  turns: TraceSessionTurn[];
}

const OTLP_KEY = "otlp:";

/** The trace's session and its turns, or null when no turn of the project holds the trace. */
export async function loadTraceSession(
  projectId: string,
  traceId: string,
  { readContent }: { readContent: boolean },
  db: ReplayDb = getDb(),
): Promise<TraceSession | null> {
  const turn = await findTraceTurn(projectId, traceId, db);
  if (!turn) return null;
  const chat = await loadSessionChat(projectId, turn.sessionId, { readContent }, db);
  if (!chat) return null;
  const traces = await loadTurnTraceIds(
    projectId,
    chat.turns.map((item) => item.turnId),
    db,
  );
  return {
    sessionId: turn.sessionId,
    title: sessionPageTitle(
      turn.sessionId,
      chat.turns.map((item) => item.ask),
    ),
    turnIndex: chat.turns.find((item) => item.turnId === turn.id)?.turnIndex ?? null,
    turns: chat.turns.map((item) => ({
      turnIndex: item.turnIndex,
      ask: item.ask,
      traceId: traces.get(item.turnId)?.[0] ?? null,
    })),
  };
}

async function findTraceTurn(
  projectId: string,
  traceId: string,
  db: ReplayDb,
): Promise<{ id: string; sessionId: string } | null> {
  const [otlp] = await db
    .select({ id: traceTurns.id, sessionId: traceTurns.sessionId })
    .from(traceTurns)
    .where(
      and(eq(traceTurns.projectId, projectId), eq(traceTurns.turnKey, `${OTLP_KEY}${traceId}`)),
    )
    .limit(1);
  if (otlp) return otlp;
  const [runtime] = await db
    .select({ id: traceTurns.id, sessionId: traceTurns.sessionId })
    .from(traceEvents)
    .innerJoin(
      traceTurnSteps,
      and(eq(traceTurnSteps.projectId, projectId), eq(traceTurnSteps.traceEventId, traceEvents.id)),
    )
    .innerJoin(
      traceTurns,
      and(eq(traceTurns.projectId, projectId), eq(traceTurns.id, traceTurnSteps.turnId)),
    )
    .where(and(eq(traceEvents.projectId, projectId), eq(traceEvents.traceId, traceId)))
    .orderBy(asc(traceTurns.startedAt))
    .limit(1);
  return runtime ?? null;
}
