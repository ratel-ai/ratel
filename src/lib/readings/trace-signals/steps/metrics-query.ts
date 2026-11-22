import { and, asc, eq, gte, lt, type SQL, sql } from "drizzle-orm";
import { OTLP_MODEL_CALL } from "@/lib/ingest/otlp/derive-model-calls";
import { traceEvents } from "@/lib/ingest/trace-events/schema";
import { traceTurns } from "@/lib/ledger/schema";
import { getDb } from "@/lib/platform/db/client";
import { traceTurnTopics } from "@/lib/readings/topics/schema";
import { taskSegments } from "@/lib/readings/trace-signals/schema";
import { OTEL_FACTS_SLACK_MS } from "../signals/otel-facts-query";
import type { ModelCallFact, RunTopicFact, SegmentFact, StepFinishInputs } from "./metrics";

/**
 * The reads behind the per-kind readings (RC-1077): model-call facts before
 * the signal run, and the window's task segments and run topics after it.
 *
 * Bounded: each read stops at {@link MAX_STEP_FACT_ROWS} rows. The model-call
 * read takes the cost and finish reason from the call's `events` row (same
 * trace and span, `otlp/reconstruct.ts`), through `events_project_trace_idx`.
 */

export type StepMetricsDb = Pick<ReturnType<typeof getDb>, "select">;

export const MAX_STEP_FACT_ROWS = 500_000;
const PAGE_SIZE = 5_000;

const eventTime = sql<Date>`coalesce(${traceEvents.occurredAt}, ${traceEvents.receivedAt})`;
/** Qualified by hand: inside the subquery an unqualified column would read the `events` row. */
const sameCall = sql`e.project_id = trace_events.project_id and e.trace_id = trace_events.trace_id and e.span_id = trace_events.span_id`;

interface Cursor {
  atRaw: string;
  id: string;
}

interface ModelCallRow {
  id: string;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  costUsd: string | null;
  finishReason: string | null;
  atRaw: string;
}

/** The window's model-call facts by `trace_events` id. */
export async function loadModelCallFacts(
  projectId: string,
  window: { start: Date; end: Date },
  db: StepMetricsDb = getDb(),
  maxRows: number = MAX_STEP_FACT_ROWS,
): Promise<Map<string, ModelCallFact>> {
  const from = new Date(window.start.getTime() - OTEL_FACTS_SLACK_MS);
  const to = new Date(window.end.getTime() + OTEL_FACTS_SLACK_MS);
  const facts = new Map<string, ModelCallFact>();
  let after: Cursor | null = null;
  while (facts.size < maxRows) {
    const keyset: SQL | undefined = after
      ? sql`(${eventTime}, ${traceEvents.id}) > (${after.atRaw}::timestamptz, ${after.id}::uuid)`
      : undefined;
    const rows: ModelCallRow[] = await db
      .select({
        id: traceEvents.id,
        inputTokens: traceEvents.inputTokens,
        outputTokens: traceEvents.outputTokens,
        reasoningTokens: sql<
          number | null
        >`case jsonb_typeof(${traceEvents.payload} -> 'reasoning_tokens') when 'number' then (${traceEvents.payload} ->> 'reasoning_tokens')::int end`,
        costUsd: sql<string | null>`(select e.cost_usd from events e where ${sameCall} limit 1)`,
        finishReason: sql<
          string | null
        >`(select e.finish_reason from events e where ${sameCall} limit 1)`,
        atRaw: sql<string>`${eventTime}::text`,
      })
      .from(traceEvents)
      .where(
        and(
          eq(traceEvents.projectId, projectId),
          eq(traceEvents.type, OTLP_MODEL_CALL),
          gte(eventTime, from),
          lt(eventTime, to),
          eq(traceEvents.ingestSource, "otlp"),
          keyset,
        ),
      )
      .orderBy(asc(eventTime), asc(traceEvents.id))
      .limit(PAGE_SIZE);
    for (const row of rows.slice(0, maxRows - facts.size)) {
      const cost = row.costUsd === null ? null : Number(row.costUsd);
      facts.set(row.id, {
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        reasoningTokens: row.reasoningTokens === null ? null : Number(row.reasoningTokens),
        costUsd: cost !== null && Number.isFinite(cost) ? cost : null,
        finishReason: row.finishReason,
      });
    }
    const last: ModelCallRow | undefined = rows.at(-1);
    if (!last || rows.length < PAGE_SIZE) break;
    after = { atRaw: last.atRaw, id: last.id };
  }
  return facts;
}

/** The task segments ending in the window and the topics of the runs ending in it. */
export async function loadStepFinishInputs(
  projectId: string,
  window: { start: Date; end: Date },
  db: StepMetricsDb = getDb(),
  maxRows: number = MAX_STEP_FACT_ROWS,
): Promise<StepFinishInputs> {
  const [segments, topics] = await Promise.all([
    db
      .select({
        workflowId: taskSegments.workflowId,
        startTurnId: taskSegments.startTurnId,
        startOrdinal: taskSegments.startOrdinal,
        endTurnId: taskSegments.endTurnId,
        endOrdinal: taskSegments.endOrdinal,
        startedAt: taskSegments.startedAt,
        endedAt: taskSegments.endedAt,
        turnIds: taskSegments.turnIds,
      })
      .from(taskSegments)
      .where(
        and(
          eq(taskSegments.projectId, projectId),
          gte(taskSegments.endedAt, window.start),
          lt(taskSegments.endedAt, window.end),
        ),
      )
      .orderBy(asc(taskSegments.endedAt), asc(taskSegments.id))
      .limit(maxRows),
    db
      .select({
        turnId: traceTurnTopics.turnId,
        verdict: traceTurnTopics.verdict,
        sentiment: traceTurnTopics.sentiment,
      })
      .from(traceTurnTopics)
      .innerJoin(traceTurns, eq(traceTurns.id, traceTurnTopics.turnId))
      .where(
        and(
          eq(traceTurnTopics.projectId, projectId),
          eq(traceTurns.projectId, projectId),
          gte(traceTurns.endedAt, window.start),
          lt(traceTurns.endedAt, window.end),
        ),
      )
      .limit(maxRows),
  ]);
  return {
    segments: segments satisfies SegmentFact[],
    topics: new Map(
      topics.map((row): [string, RunTopicFact] => [
        row.turnId,
        { sentiment: sentimentOf(row.sentiment), askedAgain: row.verdict === "retry" },
      ]),
    ),
  };
}

function sentimentOf(value: string | null): RunTopicFact["sentiment"] {
  return value === "positive" || value === "neutral" || value === "negative" ? value : null;
}
