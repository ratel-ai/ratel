import { and, eq, gte, inArray, lte } from "drizzle-orm";
import type { CloudEvent } from "@/lib/ingest/cloud-schema";
import { events } from "@/lib/ingest/otlp/schema";
import { getDb } from "@/lib/platform/db/client";
import type { EvalDb } from "./runs";

/**
 * A run's model calls (RC-61): the `events` rows (ADR-0013 raw LLM calls) of
 * the run's traces, inside its time window. Each one is a decision point: what
 * the model was given (`payload.messages` but the last, `payload.system`,
 * `payload.tools`) and what it did (the last message). Cost, tokens and
 * latency come from the promoted columns. The payload carries text only when
 * the customer captures content; it is read in-process and never copied.
 */

const ID_CHUNK = 200;
/** A run's calls start just before its first step and its last answer lands after its last step. */
const BEFORE_MS = 10_000;
const AFTER_MS = 120_000;

export interface TurnWindow {
  turnId: string;
  startedAt: Date;
  endedAt: Date;
  traceIds: readonly string[];
}

export interface ModelCall {
  turnId: string;
  occurredAt: Date;
  model: string | null;
  finishReason: string | null;
  costUsd: number | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Present only when asked for (`withPayload`). */
  payload: CloudEvent | null;
}

/** Each run's model calls, oldest first. */
export async function loadModelCalls(
  projectId: string,
  turns: readonly TurnWindow[],
  options: { withPayload?: boolean } = {},
  db: EvalDb = getDb(),
): Promise<Map<string, ModelCall[]>> {
  const out = new Map<string, ModelCall[]>();
  const byTrace = new Map<string, TurnWindow[]>();
  for (const turn of turns)
    for (const traceId of turn.traceIds)
      byTrace.set(traceId, [...(byTrace.get(traceId) ?? []), turn]);
  const traceIds = [...byTrace.keys()];
  if (traceIds.length === 0) return out;
  const earliest = new Date(Math.min(...turns.map((turn) => turn.startedAt.getTime())) - BEFORE_MS);
  const latest = new Date(Math.max(...turns.map((turn) => turn.endedAt.getTime())) + AFTER_MS);
  for (let i = 0; i < traceIds.length; i += ID_CHUNK) {
    const rows = await db
      .select({
        traceId: events.traceId,
        occurredAt: events.occurredAt,
        receivedAt: events.receivedAt,
        model: events.model,
        finishReason: events.finishReason,
        costUsd: events.costUsd,
        latencyMs: events.latencyMs,
        inputTokens: events.inputTokens,
        outputTokens: events.outputTokens,
        ...(options.withPayload ? { payload: events.payload } : {}),
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
      for (const turn of byTrace.get(row.traceId ?? "") ?? []) {
        if (
          at.getTime() < turn.startedAt.getTime() - BEFORE_MS ||
          at.getTime() > turn.endedAt.getTime() + AFTER_MS
        )
          continue;
        const cost = row.costUsd === null ? null : Number(row.costUsd);
        const list = out.get(turn.turnId) ?? [];
        list.push({
          turnId: turn.turnId,
          occurredAt: at,
          model: row.model,
          finishReason: row.finishReason,
          costUsd: cost !== null && Number.isFinite(cost) ? cost : null,
          latencyMs: row.latencyMs,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          payload: "payload" in row ? ((row.payload as CloudEvent | null) ?? null) : null,
        });
        out.set(turn.turnId, list);
      }
    }
  }
  for (const list of out.values())
    list.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  return out;
}

/** What a run's model calls cost, and whether the last one answered. */
export function callTotals(calls: readonly ModelCall[]): {
  costUsd: number | null;
  answered: boolean | null;
} {
  if (calls.length === 0) return { costUsd: null, answered: null };
  const costs = calls.map((call) => call.costUsd).filter((cost): cost is number => cost !== null);
  const last = calls[calls.length - 1]!;
  return {
    costUsd: costs.length > 0 ? costs.reduce((sum, cost) => sum + cost, 0) : null,
    answered: last.finishReason === null ? null : last.finishReason === "stop",
  };
}
