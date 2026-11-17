import { groupSpans } from "@/lib/ingest/otlp/group";
import { toRows } from "@/lib/ingest/otlp/reconstruct";
import type { OtelSpan } from "@/lib/ingest/otlp/schema";
import { normalizeSemconvAliases } from "@/lib/ingest/otlp/semconv/aliases";
import type { GenAiLogStore } from "@/lib/ingest/otlp/semconv/gen-ai-log-store";
import { attachGenAiLogEvents, type SpanKey } from "@/lib/ingest/otlp/semconv/gen-ai-logs";
import type { SessionChatCaptureEnabled } from "@/lib/ingest/otlp/session-chat-capture";
import type { DecodedSpan } from "@/lib/ingest/otlp/types";

/** The project's organization, as the edition resolves it (owned: upstream types it with its flag service). */
type IngestFlagOrganizationInput = unknown;

/**
 * Spans before logs: `gen_ai` log records
 * that arrive after their model call was stored restate that call's `events`
 * and `event_metrics` row with the content of the logs.
 *
 * The call is rebuilt from `otel_spans`, which keeps every `gen_ai.*` key but
 * the content ones, plus every stored log record of its span, so a retry or a
 * later record restates the same row again (idempotent). A call that is not
 * stored yet is skipped: its spans read the logs when they arrive
 * (`persistDecodedSpans`).
 */

export interface GenAiLogJoinDeps {
  store: GenAiLogStore;
  /** Flag `cloud-session-replay`, as span ingest reads it: the payload keeps the reply. */
  sessionChatCapture?: SessionChatCaptureEnabled;
}

/** Returns how many stored calls were restated. */
export async function rejoinStoredModelCalls(
  projectId: string,
  organization: IngestFlagOrganizationInput,
  keys: SpanKey[],
  deps: GenAiLogJoinDeps,
): Promise<number> {
  if (keys.length === 0) return 0;
  const wanted = new Set(keys.map(keyOf));
  const stored = await deps.store.findSpans(projectId, [
    ...new Set(keys.map((key) => key.traceId)),
  ]);
  const spans = stored.map(toDecodedSpan);
  if (!spans.some((span) => wanted.has(keyOf(span)))) return 0;

  attachGenAiLogEvents(spans, await deps.store.findLogs(projectId, keys));
  normalizeSemconvAliases(spans);
  const calls = groupSpans(spans);
  const captureReply =
    calls.length > 0 && deps.sessionChatCapture
      ? await deps.sessionChatCapture(projectId, organization)
      : false;
  const rows = toRows(projectId, calls, { captureReply }).filter(
    (row) =>
      row.event.traceId &&
      row.event.spanId &&
      wanted.has(`${row.event.traceId}:${row.event.spanId}`),
  );
  return deps.store.restateCalls(projectId, rows);
}

/**
 * A stored span as ingest decoded it, less what `otel_spans` drops: content
 * keys, events and resource keys other than `service.name`. The end comes from
 * the exact duration, so the latency rounds as it did at ingest.
 */
export function toDecodedSpan(row: OtelSpan): DecodedSpan {
  const startUnixMs = row.startedAt.getTime();
  return {
    traceId: row.traceId,
    spanId: row.spanId,
    parentSpanId: row.parentSpanId,
    name: row.name,
    kind: row.kind,
    startUnixMs,
    endUnixMs: startUnixMs + row.durationMs,
    attributes: structuredClone(row.attributes) as DecodedSpan["attributes"],
    events: [],
    statusCode: row.statusCode,
    resourceAttributes: row.serviceName ? { "service.name": row.serviceName } : {},
    scopeName: row.scopeName,
  };
}

function keyOf(item: SpanKey): string {
  return `${item.traceId}:${item.spanId}`;
}
