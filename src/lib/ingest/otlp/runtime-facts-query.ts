import { and, eq, inArray, sql } from "drizzle-orm";
import { traceEvents } from "@/lib/ingest/trace-events/schema";
import { getDb } from "@/lib/platform/db/client";
import type { RuntimeInvoke, RuntimeInvokeProbe } from "./runtime-duplicates";

/** Rows one probe reads at most: an export batch holds at most a few thousand tool spans. */
export const MAX_RUNTIME_INVOKES = 20_000;

const RUNTIME_INVOKE_TYPES = [
  "invoke_start",
  "invoke_end",
  "invoke_error",
  "gateway_invoke",
  "gateway_error",
];
const eventTime = sql<string>`coalesce(${traceEvents.occurredAt}, ${traceEvents.receivedAt})`;

/**
 * The project's SDK (runtime lane) invokes of the probed tools in the probed
 * sessions, between `from` and `to`. One bounded read per export batch: it
 * rides `trace_events_project_type_time_idx` (project, type, event time) over
 * the batch's time span and filters session and tool in place. Older SDK rows
 * carry no ingest source; anything not from OTLP is the SDK's.
 */
export async function findRuntimeInvokes(
  projectId: string,
  probe: RuntimeInvokeProbe,
  db: Pick<ReturnType<typeof getDb>, "select"> = getDb(),
): Promise<RuntimeInvoke[]> {
  if (probe.sessionIds.length === 0 || probe.toolIds.length === 0) return [];
  const rows = await db
    .select({
      sessionId: traceEvents.sessionId,
      toolId: traceEvents.toolId,
      atMs: sql<number>`(extract(epoch from ${eventTime}) * 1000)::float8`,
    })
    .from(traceEvents)
    .where(
      and(
        eq(traceEvents.projectId, projectId),
        inArray(traceEvents.type, RUNTIME_INVOKE_TYPES),
        sql`${eventTime} >= ${probe.from.toISOString()}::timestamptz`,
        sql`${eventTime} <= ${probe.to.toISOString()}::timestamptz`,
        sql`${traceEvents.ingestSource} is distinct from 'otlp'`,
        inArray(traceEvents.sessionId, [...probe.sessionIds]),
        inArray(traceEvents.toolId, [...probe.toolIds]),
      ),
    )
    .limit(MAX_RUNTIME_INVOKES);
  return rows.flatMap((row) =>
    row.sessionId && row.toolId
      ? [{ sessionId: row.sessionId, toolId: row.toolId, at: new Date(Number(row.atMs)) }]
      : [],
  );
}
