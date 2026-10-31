import type { NewOtelSpan } from "@/lib/ingest/otlp/schema";
import { costFor } from "@/lib/ingest/pricing";
import { deterministicEventId, MAX_QUERY } from "@/lib/ingest/trace-events/parse";
import { attrNumber, attrString } from "./anyvalue";
import { GEN_AI, RATEL, RATEL_EXPERIMENT, RATEL_SEARCH } from "./constants";
import { type AgentSpanDedupe, isAnchor, isDedupedAgentSpan, isExecuteTool } from "./group";
import type { AttrMap, DecodedSpan } from "./types";

export type SpanClass = "llm_call" | "tool" | "ratel_search" | "other";

export interface OtelSpanRow {
  id: string;
  projectId: string;
  traceId: string;
  spanId: string;
  eventId: string | null;
  sourceId: string | null;
  parentSpanId: string | null;
  name: string;
  kind: number;
  spanClass: SpanClass;
  startedAt: Date;
  endedAt: Date;
  durationMs: number;
  statusCode: number;
  serviceName: string | null;
  scopeName: string | null;
  operationName: string | null;
  providerName: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  reasoningTokens: number | null;
  costUsd: string | null;
  searchOrigin: string | null;
  searchTarget: string | null;
  searchQuery: string | null;
  searchTopK: number | null;
  searchHitCount: number | null;
  experimentName: string | null;
  experimentArm: string | null;
  experimentRole: string | null;
  experimentAttrs: Record<string, unknown>;
  attributes: Record<string, unknown>;
  attrsTruncated: boolean;
}

const MAX_ATTRIBUTE_BYTES = 16 * 1024;
const MAX_METADATA_BYTES = 1024;
const MAX_DATE_MS = 8_640_000_000_000_000;
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/i;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/i;
const ZERO_SPAN_ID = "0000000000000000";
const CONTENT_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
  GEN_AI.systemInstructions,
  GEN_AI.inputMessages,
  GEN_AI.outputMessages,
  GEN_AI.toolDefinitions,
  GEN_AI.toolCallArguments,
  GEN_AI.toolCallResult,
  GEN_AI.retrievalQueryText,
  GEN_AI.retrievalDocuments,
  GEN_AI.legacyPrompt,
  GEN_AI.legacyCompletion,
  RATEL.searchQuery,
]);
const SAFE_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set(["error.type", "server.address"]);
const LEGACY_INDEXED_CONTENT_ATTRIBUTE_PATTERN = /^gen_ai\.(?:prompt|completion)\.\d+(?:\.|$)/;

export function toOtelSpanRows(
  projectId: string,
  spans: DecodedSpan[],
  dedupe?: AgentSpanDedupe,
): OtelSpanRow[] {
  const normalizedSpans = spans.map(normalizeParentSpanId);
  return normalizedSpans.filter(isPersistableSpan).map((span) => {
    let scalarTruncated = false;
    // A deduped agent span stores no usage or cost, so every SUM over
    // otel_spans counts the run once; its raw usage stays in `attributes`.
    const deduped = isDedupedAgentSpan(span, dedupe);
    const usage = (key: string): number | null =>
      deduped ? null : intColumn(attrNumber(span.attributes, key));
    const text = (
      value: string | null | undefined,
      maxBytes = MAX_METADATA_BYTES,
    ): string | null => {
      if (value == null) return null;
      const bounded = boundedString(value, maxBytes);
      scalarTruncated ||= bounded.truncated;
      return bounded.value;
    };

    const name = text(span.name) ?? "";
    const serviceName = text(attrString(span.resourceAttributes, "service.name"));
    const eventId = text(attrString(span.attributes, RATEL.eventId));
    const scopeName = text(span.scopeName);
    const operationName = text(attrString(span.attributes, GEN_AI.operationName));
    const providerName = text(attrString(span.attributes, GEN_AI.providerName));
    const model = text(
      attrString(span.attributes, GEN_AI.responseModel) ??
        attrString(span.attributes, GEN_AI.requestModel),
    );
    const searchOrigin = text(attrString(span.attributes, RATEL.origin));
    const searchTarget = text(attrString(span.attributes, RATEL.searchTarget));
    const searchQuery = text(attrString(span.attributes, RATEL.searchQuery), MAX_QUERY);
    const experimentName = text(attrString(span.attributes, RATEL_EXPERIMENT.id));
    const experimentArm = text(attrString(span.attributes, RATEL_EXPERIMENT.arm));
    const experimentRole = text(attrString(span.attributes, RATEL_EXPERIMENT.role));
    const inputTokens = usage(GEN_AI.usageInputTokens);
    const outputTokens = usage(GEN_AI.usageOutputTokens);
    const cachedTokens = usage(GEN_AI.usageCacheRead);
    const hasCostUsage = inputTokens !== null || outputTokens !== null;
    const cost = costFor(
      model,
      hasCostUsage
        ? {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cached_tokens: cachedTokens,
            cache_write_tokens: intColumn(attrNumber(span.attributes, GEN_AI.usageCacheCreation)),
          }
        : null,
    );
    const retained = retainedAttributes(span.attributes);
    const experiment = experimentAttributes(span);

    return {
      id: deterministicEventId(projectId, `span:${span.traceId}:${span.spanId}`),
      projectId,
      traceId: span.traceId,
      spanId: span.spanId,
      eventId,
      sourceId: serviceName,
      parentSpanId: span.parentSpanId,
      name,
      kind: intColumn(span.kind) ?? 0,
      startedAt: new Date(span.startUnixMs),
      endedAt: new Date(span.endUnixMs),
      durationMs: Math.max(0, span.endUnixMs - span.startUnixMs),
      statusCode: intColumn(span.statusCode) ?? 0,
      serviceName,
      scopeName,
      spanClass: deduped ? "other" : classifySpan(span),
      operationName,
      providerName,
      model,
      inputTokens,
      outputTokens,
      cachedTokens,
      reasoningTokens: usage(GEN_AI.usageReasoning),
      costUsd: cost?.toString() ?? null,
      searchOrigin,
      searchTarget,
      searchQuery,
      searchTopK: intColumn(attrNumber(span.attributes, RATEL.searchTopK)),
      searchHitCount: intColumn(attrNumber(span.attributes, RATEL.searchHitCount)),
      experimentName,
      experimentArm,
      experimentRole,
      experimentAttrs: experiment.attributes,
      attributes: retained.attributes,
      attrsTruncated: scalarTruncated || retained.truncated || experiment.truncated,
    } satisfies NewOtelSpan;
  });
}

function normalizeParentSpanId(span: DecodedSpan): DecodedSpan {
  return span.parentSpanId === ZERO_SPAN_ID ? { ...span, parentSpanId: null } : span;
}

function isPersistableSpan(span: DecodedSpan): boolean {
  return (
    isValidTraceId(span.traceId) &&
    isValidSpanId(span.spanId) &&
    (span.parentSpanId === null || isValidSpanId(span.parentSpanId)) &&
    isValidTimestamp(span.startUnixMs) &&
    isValidTimestamp(span.endUnixMs)
  );
}

function isValidTraceId(value: string): boolean {
  return TRACE_ID_PATTERN.test(value) && !/^0+$/.test(value);
}

function isValidSpanId(value: string): boolean {
  return SPAN_ID_PATTERN.test(value) && !/^0+$/.test(value);
}

function isValidTimestamp(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= MAX_DATE_MS;
}

function classifySpan(span: DecodedSpan): SpanClass {
  if (isExecuteTool(span)) return "tool";
  if (span.name === RATEL_SEARCH) return "ratel_search";
  if (isAnchor(span)) return "llm_call";
  return "other";
}

function intColumn(value: number | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const integer = Math.trunc(value);
  return integer >= 0 && integer <= 2_147_483_647 ? integer : null;
}

function experimentAttributes(span: DecodedSpan): {
  attributes: AttrMap;
  truncated: boolean;
} {
  return boundedAttributes(
    Object.fromEntries(
      Object.entries(span.attributes).filter(([key]) => key.startsWith(RATEL_EXPERIMENT.prefix)),
    ),
  );
}

function stripContentAttributes(attributes: AttrMap): AttrMap {
  return Object.fromEntries(
    Object.entries(attributes).filter(
      ([key]) =>
        SAFE_ATTRIBUTE_KEYS.has(key) ||
        ((key.startsWith("gen_ai.") || key.startsWith("ratel.")) &&
          !CONTENT_ATTRIBUTE_KEYS.has(key) &&
          !LEGACY_INDEXED_CONTENT_ATTRIBUTE_PATTERN.test(key)),
    ),
  );
}

function retainedAttributes(attributes: AttrMap): {
  attributes: AttrMap;
  truncated: boolean;
} {
  return boundedAttributes(stripContentAttributes(attributes));
}

function boundedAttributes(attributes: AttrMap): {
  attributes: AttrMap;
  truncated: boolean;
} {
  const retained: AttrMap = {};
  let retainedCount = 0;
  let retainedBytes = 2; // Opening and closing braces.
  let truncated = false;
  for (const [key, value] of Object.entries(attributes)) {
    const serializedValue = JSON.stringify(value);
    if (serializedValue === undefined) {
      truncated = true;
      continue;
    }
    const entryBytes =
      (retainedCount > 0 ? 1 : 0) +
      Buffer.byteLength(JSON.stringify(key), "utf8") +
      1 +
      Buffer.byteLength(serializedValue, "utf8");
    if (retainedBytes + entryBytes <= MAX_ATTRIBUTE_BYTES) {
      retained[key] = value;
      retainedCount += 1;
      retainedBytes += entryBytes;
    } else {
      truncated = true;
    }
  }
  return { attributes: retained, truncated };
}

function boundedString(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maxBytes) {
    return { value, truncated: false };
  }

  let end = maxBytes;
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1;
  return {
    value: encoded.subarray(0, end).toString("utf8"),
    truncated: true,
  };
}
