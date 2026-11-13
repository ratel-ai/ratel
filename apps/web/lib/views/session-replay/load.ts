import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { events } from "@/lib/ingest/otlp/schema";
import { traceEvents } from "@/lib/ingest/trace-events/schema";
import { getDb } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import { listSessionTurns } from "@/lib/readings/tool-explorer/ledger";
import { traceSelfCorrections } from "@/lib/readings/trace-signals/schema";
import {
  buildSessionTimeline,
  type SessionTimeline,
  type TimelineModelCall,
  type TimelineTurn,
} from "./timeline";

/**
 * Reads one session of one project and builds its timeline. Model calls
 * (`events`) join a turn through the trace ids of its steps' `trace_events`
 * rows (pruned after 30 days) or its `otlp:<trace id>` key, inside the turn's
 * time window, as the eval gate joins them (`lib/eval-gate/calls.ts`).
 *
 * PRIVACY: a call's payload is tested in SQL for message or system text
 * (`has_content`); no text is selected, returned or logged.
 */

export type ReplayDb = Pick<ReturnType<typeof getDb>, "select">;

const ID_CHUNK = 500;
/** A turn's calls start just before its first step and its last answer lands after its last step. */
const BEFORE_MS = 10_000;
const AFTER_MS = 120_000;
const logger = getLogger("session-replay");

/** Message or system text in an ADR-0013 payload. Evaluated in the database. */
const HAS_CONTENT = sql<boolean>`(
  coalesce(${events.payload}->>'system', '') <> ''
  or jsonb_path_exists(${events.payload}, '$.messages[*] ? (@.content.type() == "string" && @.content != "")')
  or jsonb_path_exists(${events.payload}, '$.messages[*].content[*] ? (@.type == "text" && @.text != "")')
)`;

/** The session's timeline, or null when the project has no closed turn in it. */
export async function loadSessionTimeline(
  projectId: string,
  sessionId: string,
  db: ReplayDb = getDb(),
): Promise<SessionTimeline | null> {
  const ledger = await listSessionTurns(projectId, sessionId, db);
  if (ledger.length === 0) return null;
  const eventIds = [
    ...new Set(ledger.flatMap(({ steps }) => steps.map((step) => step.traceEventId))),
  ];
  const traceIdByEvent = await loadTraceIds(projectId, eventIds, db);
  const turns: TimelineTurn[] = ledger.map(({ turn, steps }) => ({
    id: turn.id,
    startedAt: turn.startedAt,
    endedAt: turn.endedAt,
    endedBy: turn.endedBy,
    abandoned: turn.abandoned,
    detour: turn.detour,
    reSearchCount: turn.reSearchCount,
    steps: steps
      .filter((step) => step.kind === "search" || step.kind === "invoke")
      .map((step) => ({
        ordinal: step.ordinal,
        kind: step.kind as "search" | "invoke",
        traceEventId: step.traceEventId,
        occurredAt: step.occurredAt,
        eventPresent: traceIdByEvent.has(step.traceEventId),
        targetType: step.targetType,
        targetId: step.targetId,
        outcome: step.outcome,
        tookMs: step.tookMs,
        searchType: step.searchType,
        hitCount: step.hitCount,
        hitIds: step.hitIds,
      })),
  }));
  const traceIdsByTurn = new Map(
    ledger.map(({ turn, steps }) => {
      const ids = new Set(
        steps
          .map((step) => traceIdByEvent.get(step.traceEventId))
          .filter((id): id is string => !!id),
      );
      if (turn.turnKey.startsWith("otlp:")) ids.add(turn.turnKey.slice("otlp:".length));
      return [turn.id, ids] as const;
    }),
  );
  const turnIds = turns.map((turn) => turn.id);
  const [modelCalls, selfCorrections] = await Promise.all([
    loadCalls(projectId, turns, traceIdsByTurn, db),
    db
      .select({
        turnId: traceSelfCorrections.turnId,
        kind: traceSelfCorrections.kind,
        stepOrdinal: traceSelfCorrections.stepOrdinal,
      })
      .from(traceSelfCorrections)
      .where(
        and(
          eq(traceSelfCorrections.projectId, projectId),
          inArray(traceSelfCorrections.turnId, turnIds),
        ),
      ),
  ]);
  const timeline = buildSessionTimeline({ sessionId, turns, modelCalls, selfCorrections });
  logger.info(
    {
      project_id: projectId,
      turns: timeline.turnCount,
      steps: timeline.steps.length,
      model_calls: modelCalls.length,
      coverage_content: timeline.coverage.content,
      coverage_tokens_only: timeline.coverage.tokens_only,
      coverage_expired: timeline.coverage.expired,
    },
    "session_replay_timeline_built",
  );
  return timeline;
}

/** Trace id by `trace_events` id, for the rows not yet pruned (a row with no trace id maps to ""). */
async function loadTraceIds(
  projectId: string,
  eventIds: readonly string[],
  db: ReplayDb,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < eventIds.length; i += ID_CHUNK) {
    const rows = await db
      .select({ id: traceEvents.id, traceId: traceEvents.traceId })
      .from(traceEvents)
      .where(
        and(
          eq(traceEvents.projectId, projectId),
          inArray(traceEvents.id, eventIds.slice(i, i + ID_CHUNK)),
        ),
      );
    for (const row of rows) out.set(row.id, row.traceId ?? "");
  }
  return out;
}

/** The turns' model calls, each given to one turn: the latest one started by then among those sharing its trace. */
async function loadCalls(
  projectId: string,
  turns: readonly TimelineTurn[],
  traceIdsByTurn: ReadonlyMap<string, ReadonlySet<string>>,
  db: ReplayDb,
): Promise<TimelineModelCall[]> {
  const byTrace = new Map<string, TimelineTurn[]>();
  for (const turn of turns)
    for (const traceId of traceIdsByTurn.get(turn.id) ?? [])
      byTrace.set(traceId, [...(byTrace.get(traceId) ?? []), turn]);
  const traceIds = [...byTrace.keys()];
  if (traceIds.length === 0) return [];
  const earliest = new Date(Math.min(...turns.map((turn) => turn.startedAt.getTime())) - BEFORE_MS);
  const latest = new Date(Math.max(...turns.map((turn) => turn.endedAt.getTime())) + AFTER_MS);
  const out: TimelineModelCall[] = [];
  for (let i = 0; i < traceIds.length; i += ID_CHUNK) {
    const rows = await db
      .select({
        id: events.id,
        traceId: events.traceId,
        occurredAt: events.occurredAt,
        receivedAt: events.receivedAt,
        model: events.model,
        finishReason: events.finishReason,
        inputTokens: events.inputTokens,
        outputTokens: events.outputTokens,
        cachedTokens: events.cachedTokens,
        costUsd: events.costUsd,
        latencyMs: events.latencyMs,
        hasContent: HAS_CONTENT,
      })
      .from(events)
      .where(
        and(
          eq(events.projectId, projectId),
          inArray(events.traceId, traceIds.slice(i, i + ID_CHUNK)),
          gte(events.occurredAt, earliest),
          lte(events.occurredAt, latest),
        ),
      );
    for (const row of rows) {
      const at = row.occurredAt ?? row.receivedAt;
      const turn = owningTurn(byTrace.get(row.traceId ?? "") ?? [], at);
      if (!turn) continue;
      const cost = row.costUsd === null ? null : Number(row.costUsd);
      out.push({
        eventId: row.id,
        turnId: turn.id,
        occurredAt: at,
        model: row.model,
        finishReason: row.finishReason,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cachedTokens: row.cachedTokens,
        costUsd: cost !== null && Number.isFinite(cost) ? cost : null,
        latencyMs: row.latencyMs,
        hasContent: row.hasContent === true,
      });
    }
  }
  return out;
}

function owningTurn(candidates: readonly TimelineTurn[], at: Date): TimelineTurn | null {
  const t = at.getTime();
  const inWindow = candidates.filter(
    (turn) => t >= turn.startedAt.getTime() - BEFORE_MS && t <= turn.endedAt.getTime() + AFTER_MS,
  );
  const started = inWindow
    .filter((turn) => turn.startedAt.getTime() <= t)
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
  return started[0] ?? inWindow[0] ?? null;
}
