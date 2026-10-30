import { and, asc, eq, inArray } from "drizzle-orm";
import { traceEvents } from "@/lib/ingest/trace-events/schema";
import {
  type TraceTurnRow,
  type TraceTurnStepRow,
  traceTurnSteps,
  traceTurns,
} from "@/lib/ledger/schema";
import { getDb } from "@/lib/platform/db/client";
import { queryIntentOccurrences, queryIntents } from "@/lib/readings/query-intents/schema";
import type { ErrorInfo } from "@/lib/readings/tool-explorer/reliability";
import type { SignalTurn } from "@/lib/readings/trace-signals/signals/types";

/**
 * What the explorer reads from the turn ledger itself, beside Agent health's
 * page reads: the intents behind a turn's searches, the error message behind
 * an error step, and one session's turns for the drill-down. The categorize
 * job writes one `query_intent_occurrences` row per (search event, extracted
 * intent); a turn's search steps point at those events by `trace_event_id`,
 * so the join needs no new column anywhere. Chunked, like the step loads in
 * Agent health's ledger.
 */

export type ExplorerLedgerDb = ReturnType<typeof getDb>;
const ID_CHUNK = 500;

/** Intent ids per search event, for the events given. */
export async function loadIntentsForEvents(
  projectId: string,
  traceEventIds: readonly string[],
  db: Pick<ExplorerLedgerDb, "select"> = getDb(),
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < traceEventIds.length; i += ID_CHUNK) {
    const rows = await db
      .select({
        eventId: queryIntentOccurrences.traceEventId,
        intentId: queryIntentOccurrences.queryIntentId,
      })
      .from(queryIntentOccurrences)
      .where(
        and(
          eq(queryIntentOccurrences.projectId, projectId),
          inArray(queryIntentOccurrences.traceEventId, traceEventIds.slice(i, i + ID_CHUNK)),
        ),
      );
    for (const row of rows) out.set(row.eventId, [...(out.get(row.eventId) ?? []), row.intentId]);
  }
  return out;
}

/** The intents of a page of turns, in each turn's search order. */
export async function intentsForTurns(
  projectId: string,
  turns: readonly Pick<SignalTurn, "id" | "steps">[],
  db: Pick<ExplorerLedgerDb, "select"> = getDb(),
  load: typeof loadIntentsForEvents = loadIntentsForEvents,
): Promise<Map<string, string[]>> {
  const searchEvents = turns.flatMap((turn) =>
    turn.steps.filter((step) => step.kind === "search").map((step) => step.traceEventId),
  );
  if (searchEvents.length === 0) return new Map();
  const byEvent = await load(projectId, searchEvents, db);
  const out = new Map<string, string[]>();
  for (const turn of turns) {
    const intents = turn.steps
      .filter((step) => step.kind === "search")
      .flatMap((step) => byEvent.get(step.traceEventId) ?? []);
    if (intents.length > 0) out.set(turn.id, intents);
  }
  return out;
}

/** Intent texts by id, to name groups and label the page. */
export async function loadIntentTexts(
  projectId: string,
  intentIds: readonly string[],
  db: Pick<ExplorerLedgerDb, "select"> = getDb(),
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < intentIds.length; i += ID_CHUNK) {
    const rows = await db
      .select({ id: queryIntents.id, text: queryIntents.text })
      .from(queryIntents)
      .where(
        and(
          eq(queryIntents.projectId, projectId),
          inArray(queryIntents.id, intentIds.slice(i, i + ID_CHUNK)),
        ),
      );
    for (const row of rows) out.set(row.id, row.text);
  }
  return out;
}

/** One session's closed turns with their steps, oldest first, for the drill-down. */
export async function listSessionTurns(
  projectId: string,
  sessionId: string,
  db: Pick<ExplorerLedgerDb, "select"> = getDb(),
  limit = 200,
): Promise<{ turn: TraceTurnRow; steps: TraceTurnStepRow[] }[]> {
  const turns = await db
    .select()
    .from(traceTurns)
    .where(
      and(
        eq(traceTurns.projectId, projectId),
        eq(traceTurns.sessionId, sessionId),
        eq(traceTurns.status, "closed"),
      ),
    )
    .orderBy(asc(traceTurns.startedAt), asc(traceTurns.id))
    .limit(limit);
  if (turns.length === 0) return [];
  const steps = await db
    .select()
    .from(traceTurnSteps)
    .where(
      inArray(
        traceTurnSteps.turnId,
        turns.map((t) => t.id),
      ),
    )
    .orderBy(asc(traceTurnSteps.turnId), asc(traceTurnSteps.ordinal));
  const byTurn = new Map<string, TraceTurnStepRow[]>();
  for (const step of steps) byTurn.set(step.turnId, [...(byTurn.get(step.turnId) ?? []), step]);
  return turns.map((turn) => ({ turn, steps: byTurn.get(turn.id) ?? [] }));
}

const ERROR_MESSAGE_CHUNK = 1_000;

/**
 * The error message each of these runtime events carried, by event id, for
 * the error steps of a page of turns (`steps[].endTraceEventId`). Events
 * past the 30-day prune are simply absent, and read as no message.
 */
export async function errorMessagesFor(
  projectId: string,
  eventIds: readonly string[],
  db: Pick<ExplorerLedgerDb, "select"> = getDb(),
): Promise<Map<string, ErrorInfo>> {
  const out = new Map<string, ErrorInfo>();
  for (let i = 0; i < eventIds.length; i += ERROR_MESSAGE_CHUNK) {
    const chunk = eventIds.slice(i, i + ERROR_MESSAGE_CHUNK);
    const rows = await db
      .select({ id: traceEvents.id, message: traceEvents.errorMessage })
      .from(traceEvents)
      .where(and(eq(traceEvents.projectId, projectId), inArray(traceEvents.id, chunk)));
    for (const row of rows) out.set(row.id, { message: row.message });
  }
  return out;
}
