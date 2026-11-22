import { isContentFreeAttributeKey } from "./span-rows";
import type { AttrMap, DecodedSpan } from "./types";

/**
 * What an `otel_spans` row keeps of a span's events and links (AOBS-7). A coding agent reports a compaction, a permission
 * decision, a hook and a human wait as span events; a link points a span at
 * another trace (a background task, a message from another chat).
 *
 * Only content-free attributes are kept, by the rule of the row's own
 * attributes (`isContentFreeAttributeKey`): an event that carried only content
 * (the inference details event, a `gen_ai` message event) is not stored.
 * Both lists are bounded in count and in bytes.
 */

/** One stored span event. */
export interface StoredSpanEvent {
  name: string;
  /** Unix epoch milliseconds. */
  timeUnixMs: number;
  attributes: Record<string, unknown>;
}

/** One stored span link: the span it points at, in lowercase hex. */
export interface StoredSpanLink {
  traceId: string;
  spanId: string;
  attributes: Record<string, unknown>;
}

export interface Stored<T> {
  /** Null when the span has nothing to keep. */
  value: T[] | null;
  /** The span had more than the bounds keep. */
  truncated: boolean;
}

const MAX_EVENTS = 256;
const MAX_LINKS = 64;
const MAX_EVENT_BYTES = 32 * 1024;
const MAX_LINK_BYTES = 8 * 1024;
const MAX_EVENT_NAME = 256;
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;

/** The span's events an `otel_spans` row keeps, in the order they arrived. */
export function storedSpanEvents(span: DecodedSpan): Stored<StoredSpanEvent> {
  const kept: StoredSpanEvent[] = [];
  for (const event of span.events) {
    const attributes = contentFree(event.attributes);
    // An event whose every attribute was content is content itself.
    if (Object.keys(event.attributes).length > 0 && Object.keys(attributes).length === 0) continue;
    if (!Number.isFinite(event.timeUnixMs)) continue;
    kept.push({
      name: event.name.slice(0, MAX_EVENT_NAME),
      timeUnixMs: event.timeUnixMs,
      attributes,
    });
  }
  return bounded(kept, MAX_EVENTS, MAX_EVENT_BYTES);
}

/** The span's links an `otel_spans` row keeps. A link without a valid target is dropped. */
export function storedSpanLinks(span: DecodedSpan): Stored<StoredSpanLink> {
  const kept: StoredSpanLink[] = [];
  for (const link of span.links ?? []) {
    const traceId = link.traceId.toLowerCase();
    const spanId = link.spanId.toLowerCase();
    if (!isId(traceId, TRACE_ID_PATTERN) || !isId(spanId, SPAN_ID_PATTERN)) continue;
    kept.push({ traceId, spanId, attributes: contentFree(link.attributes) });
  }
  return bounded(kept, MAX_LINKS, MAX_LINK_BYTES);
}

function contentFree(attributes: AttrMap): AttrMap {
  return Object.fromEntries(
    Object.entries(attributes).filter(([key]) => isContentFreeAttributeKey(key)),
  );
}

function isId(value: string, pattern: RegExp): boolean {
  return pattern.test(value) && !/^0+$/.test(value);
}

/** The first items that fit the count and the serialized bytes. */
function bounded<T>(items: T[], maxCount: number, maxBytes: number): Stored<T> {
  if (items.length === 0) return { value: null, truncated: false };
  const value: T[] = [];
  let bytes = 2; // The brackets.
  for (const item of items) {
    const size = Buffer.byteLength(JSON.stringify(item), "utf8") + (value.length > 0 ? 1 : 0);
    if (value.length >= maxCount || bytes + size > maxBytes)
      return { value: value.length > 0 ? value : null, truncated: true };
    value.push(item);
    bytes += size;
  }
  return { value, truncated: false };
}
