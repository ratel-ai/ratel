import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { CloudEvent } from "@/lib/ingest/cloud-schema";
import { PLAYGROUND_ENVIRONMENT } from "@/lib/ingest/otlp/playground";
import { events, otelSpans } from "@/lib/ingest/otlp/schema";
import { recordedReply } from "../recorded-reply";
import type { RunMetrics } from "../replay";
import type { SandboxDb } from "./pg-store";

/**
 * Recorded items of a sandbox (RC-1103, spec §4): the production item calls that
 * carry `ratel.sandbox.input`, with the reply production gave. Raw telemetry
 * expires after 30 days, so the read is bounded by the project and 30 days
 * (`otel_spans_project_started_trace_idx`). The reply comes from the call's
 * `events.payload` (`events_project_trace_idx`), because ingest strips
 * content from the spans.
 *
 * PRIVACY: the input and the reply are customer content on the project's own
 * spans; they go only to a member of that project, and nothing here logs them.
 */

export interface RecordedItemsQuery {
  projectId: string;
  sandboxId: string;
  now: Date;
  /** Only these spans. Absent: the newest items up to `limit`. */
  spanIds?: readonly string[];
  limit?: number;
}

export interface RecordedItem {
  spanId: string;
  traceId: string;
  startedAt: Date;
  /** The item's input: the parsed `ratel.sandbox.input`, or its text when it is cut. */
  input: unknown;
  /** The recorded reply, parsed as JSON when it parses; null when production stored none. */
  recordedOutput: unknown;
}

export interface TraceMetrics extends RunMetrics {
  /** Spans of the trace stored so far: 0 until the runner's exporter sends them. */
  spans: number;
}

export const RECORDED_ITEMS_WINDOW_DAYS = 30;
const DEFAULT_LIMIT = 50;
const DAY_MS = 86_400_000;
const SANDBOX_ID = "ratel.sandbox.id";
const SANDBOX_INPUT = "ratel.sandbox.input";
const ENVIRONMENT = "deployment.environment.name";

export async function readRecordedItems(
  db: SandboxDb,
  query: RecordedItemsQuery,
): Promise<RecordedItem[]> {
  const since = new Date(query.now.getTime() - RECORDED_ITEMS_WINDOW_DAYS * DAY_MS);
  const rows = await db
    .select({
      spanId: otelSpans.spanId,
      traceId: otelSpans.traceId,
      startedAt: otelSpans.startedAt,
      input: sql<string>`${otelSpans.attributes}->>${SANDBOX_INPUT}`,
    })
    .from(otelSpans)
    .where(
      and(
        eq(otelSpans.projectId, query.projectId),
        gte(otelSpans.startedAt, since),
        sql`${otelSpans.attributes} ? ${SANDBOX_INPUT}`,
        sql`${otelSpans.attributes}->>${SANDBOX_ID} = ${query.sandboxId}`,
        sql`${otelSpans.attributes}->>${ENVIRONMENT} is distinct from ${PLAYGROUND_ENVIRONMENT}`,
        query.spanIds ? inArray(otelSpans.spanId, [...query.spanIds]) : undefined,
      ),
    )
    .orderBy(desc(otelSpans.startedAt), desc(otelSpans.spanId))
    .limit(query.spanIds ? query.spanIds.length : (query.limit ?? DEFAULT_LIMIT));
  if (rows.length === 0) return [];

  const replies = await db
    .select({ traceId: events.traceId, spanId: events.spanId, payload: events.payload })
    .from(events)
    .where(
      and(
        eq(events.projectId, query.projectId),
        inArray(events.traceId, [...new Set(rows.map((r) => r.traceId))]),
        inArray(
          events.spanId,
          rows.map((r) => r.spanId),
        ),
      ),
    );
  const replyBySpan = new Map(
    replies.map((r) => [`${r.traceId}:${r.spanId}`, r.payload as CloudEvent | null]),
  );
  return rows.map((row) => ({
    spanId: row.spanId,
    traceId: row.traceId,
    startedAt: row.startedAt,
    input: parseInput(row.input),
    recordedOutput: recordedReply(replyBySpan.get(`${row.traceId}:${row.spanId}`)),
  }));
}

/**
 * A run's tokens, cost and latency from its trace's spans: the sums over the
 * trace, and the root span's duration. The runner exports spans in batches, so
 * they land a few seconds after the run ends; `spans` says how many are in.
 */
export async function readTraceMetrics(
  db: SandboxDb,
  query: { projectId: string; traceId: string },
): Promise<TraceMetrics> {
  const [row] = await db
    .select({
      spans: sql<number>`count(*)::int`,
      inputTokens: sql<number>`coalesce(sum(${otelSpans.inputTokens}), 0)::int`,
      outputTokens: sql<number>`coalesce(sum(${otelSpans.outputTokens}), 0)::int`,
      costUsd: sql<string>`coalesce(sum(${otelSpans.costUsd}), 0)::text`,
      latencyMs: sql<
        number | null
      >`max(${otelSpans.durationMs}) filter (where ${otelSpans.parentSpanId} is null)`,
    })
    .from(otelSpans)
    .where(and(eq(otelSpans.projectId, query.projectId), eq(otelSpans.traceId, query.traceId)));
  return {
    spans: Number(row?.spans ?? 0),
    inputTokens: Number(row?.inputTokens ?? 0),
    outputTokens: Number(row?.outputTokens ?? 0),
    costUsd: Number(row?.costUsd ?? 0),
    latencyMs:
      row?.latencyMs === null || row?.latencyMs === undefined ? null : Number(row.latencyMs),
  };
}

function parseInput(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // A capped input can be cut mid-JSON: it stays as its text, and the form shows it to fix.
    return text;
  }
}
