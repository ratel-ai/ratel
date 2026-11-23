import type { AttrMap, AttrValue, DecodedEvent, DecodedSpan } from "../types";

/**
 * `gen_ai` log records joined to their
 * model call. An emitter may send a call's content as log records (the
 * `gen_ai.client.inference.operation.details` event, or the five older
 * per-message events) instead of span events. `/v1/logs` stores them in
 * `otel_logs` (`log-rows.ts`); here they become span events of the span with
 * the same trace and span id, so the readers of span events
 * (`group.ts`, `legacy-content.ts`) read them as if the span carried them.
 */

/** One stored `gen_ai` log record, as `otel_logs` keeps it. */
export interface StoredGenAiLog {
  traceId: string;
  spanId: string;
  eventName: string;
  occurredAt: Date;
  attributes: Record<string, unknown>;
  body: unknown;
}

export interface SpanKey {
  traceId: string;
  spanId: string;
}

/**
 * Mutates `spans`: appends each span's stored log records as span events, in
 * time order. A span event the span already carries wins: a log record of the
 * same name is not added.
 */
export function attachGenAiLogEvents(spans: DecodedSpan[], logs: readonly StoredGenAiLog[]): void {
  if (logs.length === 0) return;
  const bySpan = new Map<string, StoredGenAiLog[]>();
  for (const log of logs) {
    const key = spanKeyOf(log);
    bySpan.set(key, [...(bySpan.get(key) ?? []), log]);
  }
  for (const span of spans) {
    const found = bySpan.get(spanKeyOf(span));
    if (!found) continue;
    const own = new Set(span.events.map((event) => event.name));
    const added = [...found]
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
      .filter((log) => !own.has(log.eventName))
      .map(toSpanEvent);
    span.events = [...span.events, ...added];
  }
}

/** The distinct trace and span ids of `items`, without empty ids. */
export function distinctSpanKeys(
  items: Iterable<{ traceId: string | null; spanId: string | null }>,
): SpanKey[] {
  const keys = new Map<string, SpanKey>();
  for (const { traceId, spanId } of items) {
    if (traceId && spanId) keys.set(`${traceId}:${spanId}`, { traceId, spanId });
  }
  return [...keys.values()];
}

/**
 * A log record as a span event. A per-message record carries its message in
 * the body (`{ content, tool_calls, id }`, or `{ message, finish_reason }` for
 * `gen_ai.choice`), where a span event carries it in its attributes. A string
 * body is the message content.
 */
function toSpanEvent(log: StoredGenAiLog): DecodedEvent {
  const body = log.body;
  const fromBody: AttrMap =
    typeof body === "string"
      ? { content: body }
      : body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, AttrValue>)
        : {};
  return {
    name: log.eventName,
    timeUnixMs: log.occurredAt.getTime(),
    attributes: { ...(log.attributes as AttrMap), ...fromBody },
  };
}

function spanKeyOf(item: SpanKey): string {
  return `${item.traceId}:${item.spanId}`;
}
