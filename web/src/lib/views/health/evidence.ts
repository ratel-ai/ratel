import { and, eq, inArray, sql } from "drizzle-orm";
import { traceEvents } from "@/lib/ingest/trace-events/schema";
import { loadStepsByTurn } from "@/lib/ledger/closed-turns";
import { traceTurns } from "@/lib/ledger/schema";
import type { TurnSource } from "@/lib/ledger/types";
import { getDb } from "@/lib/platform/db/client";
import type { EvidenceTurn, SignalKind } from "@/lib/readings/trace-signals/view";
import { type LiveEvent, storyOf } from "@/lib/views/health/signals/story";

/**
 * The evidence drawer's data: for each signal, its first sampled turns (the
 * stored `evidence.turnIds`, newest first) as stories. Turns and steps come from
 * the durable ledger; query text and the trace id are read LIVE from
 * `trace_events` by id, never stored, so a pruned event reads `expired`.
 *
 * `perSignal` is the plan's `agentHealthEvidenceTurns`: at 0 (the free plan)
 * nothing is read at all. Every read is scoped to the project, so a turn id
 * that is not the project's simply yields no story.
 */

export type EvidenceDb = Pick<ReturnType<typeof getDb>, "select">;

export interface EvidenceRequest {
  signalId: string;
  kind: SignalKind;
  subjectIds: readonly string[];
  turnIds: readonly string[];
}

const ID_CHUNK = 500;

export async function loadEvidenceTurns(
  projectId: string,
  requests: readonly EvidenceRequest[],
  perSignal: number,
  names: ReadonlyMap<string, string>,
  db: EvidenceDb = getDb(),
): Promise<Map<string, EvidenceTurn[]>> {
  const out = new Map<string, EvidenceTurn[]>();
  const limit = Number.isFinite(perSignal) ? Math.max(0, Math.floor(perSignal)) : Infinity;
  if (limit === 0 || requests.length === 0) return out;
  const wanted = requests.map((r) => ({ ...r, turnIds: r.turnIds.slice(0, limit) }));
  const turnIds = [...new Set(wanted.flatMap((r) => r.turnIds))];
  if (turnIds.length === 0) return out;

  const turns = await loadTurnHeads(projectId, turnIds, db);
  const steps = await loadStepsByTurn([...turns.keys()], db);
  const eventIds = [...new Set([...steps.values()].flat().map((s) => s.traceEventId))];
  const events = await loadLiveEvents(projectId, eventIds, db);

  for (const request of wanted) {
    const stories = request.turnIds.flatMap((turnId) => {
      const turn = turns.get(turnId);
      if (!turn) return [];
      return [
        storyOf({
          kind: request.kind,
          subjectIds: request.subjectIds,
          names,
          turn,
          steps: steps.get(turnId) ?? [],
          events,
        }),
      ];
    });
    out.set(request.signalId, stories);
  }
  return out;
}

async function loadTurnHeads(
  projectId: string,
  turnIds: readonly string[],
  db: EvidenceDb,
): Promise<Map<string, { id: string; startedAt: Date; turnSource: TurnSource }>> {
  const out = new Map<string, { id: string; startedAt: Date; turnSource: TurnSource }>();
  for (let i = 0; i < turnIds.length; i += ID_CHUNK) {
    const rows = await db
      .select({
        id: traceTurns.id,
        startedAt: traceTurns.startedAt,
        turnSource: traceTurns.turnSource,
      })
      .from(traceTurns)
      .where(
        and(
          eq(traceTurns.projectId, projectId),
          inArray(traceTurns.id, turnIds.slice(i, i + ID_CHUNK)),
        ),
      );
    for (const row of rows) out.set(row.id, { ...row, turnSource: row.turnSource as TurnSource });
  }
  return out;
}

async function loadLiveEvents(
  projectId: string,
  eventIds: readonly string[],
  db: EvidenceDb,
): Promise<Map<string, LiveEvent>> {
  const out = new Map<string, LiveEvent>();
  for (let i = 0; i < eventIds.length; i += ID_CHUNK) {
    const rows = await db
      .select({
        id: traceEvents.id,
        query: traceEvents.query,
        traceId: traceEvents.traceId,
        resultEmpty: sql<
          boolean | null
        >`case jsonb_typeof(${traceEvents.payload} -> 'result_empty') when 'boolean' then (${traceEvents.payload} ->> 'result_empty')::boolean end`,
      })
      .from(traceEvents)
      .where(
        and(
          eq(traceEvents.projectId, projectId),
          inArray(traceEvents.id, eventIds.slice(i, i + ID_CHUNK)),
        ),
      );
    for (const row of rows) {
      out.set(row.id, { query: row.query, traceId: row.traceId, resultEmpty: row.resultEmpty });
    }
  }
  return out;
}
