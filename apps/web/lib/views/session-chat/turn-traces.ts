import { and, eq, inArray, isNotNull, isNull, min } from "drizzle-orm";
import { otelSpans } from "@/lib/ingest/otlp/schema";
import { traceEvents } from "@/lib/ingest/trace-events/schema";
import { traceTurnSteps, traceTurns } from "@/lib/ledger/schema";
import { getDb } from "@/lib/platform/db/client";
import type { ReplayDb } from "@/lib/views/session-replay/load";

/**
 * The runs (traces) behind each turn, for the session replay's Trace view
 * (RC-314). An OTLP turn is its `otlp:<trace id>` run; a runtime-lane turn has
 * the runs its steps' events carry (those events are pruned after 30 days).
 * Only runs with spans in the project count, earliest top-level span first.
 */

const OTLP_KEY = "otlp:";

/** Each turn's runs, in time order; a turn with none maps to `[]`. */
export async function loadTurnTraceIds(
  projectId: string,
  turnIds: readonly string[],
  db: ReplayDb = getDb(),
): Promise<Map<string, string[]>> {
  const ids = [...new Set(turnIds)];
  if (ids.length === 0) return new Map();
  const turns = await db
    .select({ id: traceTurns.id, turnKey: traceTurns.turnKey })
    .from(traceTurns)
    .where(and(eq(traceTurns.projectId, projectId), inArray(traceTurns.id, ids)));
  const candidates = new Map<string, Set<string>>(ids.map((id) => [id, new Set()]));
  for (const turn of turns)
    if (turn.turnKey.startsWith(OTLP_KEY))
      candidates.get(turn.id)?.add(turn.turnKey.slice(OTLP_KEY.length));
  const runtime = await db
    .select({ turnId: traceTurnSteps.turnId, traceId: traceEvents.traceId })
    .from(traceTurnSteps)
    .innerJoin(
      traceEvents,
      and(eq(traceEvents.projectId, projectId), eq(traceEvents.id, traceTurnSteps.traceEventId)),
    )
    .where(
      and(
        eq(traceTurnSteps.projectId, projectId),
        inArray(
          traceTurnSteps.turnId,
          turns.map((turn) => turn.id),
        ),
        isNotNull(traceEvents.traceId),
      ),
    )
    .groupBy(traceTurnSteps.turnId, traceEvents.traceId);
  for (const row of runtime) if (row.traceId) candidates.get(row.turnId)?.add(row.traceId);

  const all = [...new Set([...candidates.values()].flatMap((set) => [...set]))];
  const starts = all.length
    ? await db
        .select({ traceId: otelSpans.traceId, startedAt: min(otelSpans.startedAt) })
        .from(otelSpans)
        .where(
          and(
            eq(otelSpans.projectId, projectId),
            inArray(otelSpans.traceId, all),
            isNull(otelSpans.parentSpanId),
          ),
        )
        .groupBy(otelSpans.traceId)
    : [];
  const startOf = new Map(starts.map((row) => [row.traceId, row.startedAt?.getTime() ?? 0]));
  return new Map(
    [...candidates].map(([turnId, traces]) => [
      turnId,
      [...traces]
        .filter((id) => startOf.has(id))
        .sort((a, b) => (startOf.get(a) ?? 0) - (startOf.get(b) ?? 0) || (a < b ? -1 : 1)),
    ]),
  );
}
