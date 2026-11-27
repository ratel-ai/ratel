import type { NewRuntimeCatalogEntry } from "@/lib/ingest/runtime-catalog/schema";
import { contentHash, deterministicEventId } from "@/lib/ingest/trace-events/parse";
import { attrString } from "./anyvalue";
import { GEN_AI, RATEL, RATEL_CATALOG, RATEL_EXPERIMENT } from "./constants";
import type { AttrMap, AttrValue, DecodedLogRecord } from "./types";

export interface OtelLogRow {
  id: string;
  projectId: string;
  eventId: string | null;
  sourceId: string | null;
  ingestSource: "otlp";
  occurredAt: Date;
  eventName: string;
  traceId: string | null;
  spanId: string | null;
  severityNumber: number;
  serviceName: string | null;
  scopeName: string | null;
  body: AttrValue;
  experimentName: string | null;
  experimentArm: string | null;
  experimentRole: string | null;
  experimentSelectionId: string | null;
  experimentAttrs: Record<string, unknown>;
  attributes: Record<string, unknown>;
  attrsTruncated: boolean;
  catalogDefinition?: Omit<NewRuntimeCatalogEntry, "projectId" | "firstSeenAt">;
}

export interface OtelLogRowsResult {
  rows: OtelLogRow[];
  dropped: number;
}

/** The `gen_ai` log events that carry a model call's messages. */
export const GEN_AI_LOG_EVENT_NAMES: ReadonlySet<string> = new Set([
  "gen_ai.client.inference.operation.details",
  "gen_ai.system.message",
  "gen_ai.user.message",
  "gen_ai.assistant.message",
  "gen_ai.tool.message",
  "gen_ai.choice",
]);

const MAX_ATTRIBUTE_BYTES = 16 * 1024;
/** A `gen_ai` event carries whole messages, so it gets the span content budget. */
const MAX_GEN_AI_CONTENT_BYTES = 256 * 1024;
const MAX_METADATA_BYTES = 1024;
const MAX_CATALOG_IDENTITY_CHARS = 256;
const MAX_DATE_MS = 8_640_000_000_000_000;
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
  RATEL_CATALOG.kind,
  RATEL_CATALOG.id,
  RATEL_CATALOG.name,
  RATEL_CATALOG.description,
  RATEL_CATALOG.tags,
  RATEL_CATALOG.inputSchema,
  RATEL_CATALOG.outputSchema,
  RATEL_CATALOG.searchableDescription,
  RATEL_CATALOG.searchableDescriptionOverridden,
  RATEL_CATALOG.useCloudDefinitions,
  RATEL_CATALOG.contentHash,
  "ratel.experiment.result_attrs",
]);
const SAFE_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set(["error.type", "server.address"]);
const LEGACY_INDEXED_CONTENT_ATTRIBUTE_PATTERN = /^gen_ai\.(?:prompt|completion)\.\d+(?:\.|$)/;

/**
 * Filter and map normalized OTLP log records into standalone persistence rows. `receivedAt` is the
 * time of a record without a usable one (a queued export, ADR-0010); absent, now.
 */
export function toOtelLogRows(
  projectId: string,
  records: DecodedLogRecord[],
  receivedAt?: Date,
): OtelLogRowsResult {
  const accepted = records.filter(
    (record) =>
      record.eventName.startsWith("ratel.") || GEN_AI_LOG_EVENT_NAMES.has(record.eventName),
  );

  return {
    rows: accepted.map((record) => toOtelLogRow(projectId, record, receivedAt)),
    dropped: records.length - accepted.length,
  };
}

function toOtelLogRow(
  projectId: string,
  record: DecodedLogRecord,
  receivedAt: Date | undefined,
): OtelLogRow {
  const genAiEvent = GEN_AI_LOG_EVENT_NAMES.has(record.eventName);
  let scalarTruncated = false;
  const text = (value: string | null | undefined): string | null => {
    if (value == null) return null;
    const bounded = boundedString(value, MAX_METADATA_BYTES);
    scalarTruncated ||= bounded.truncated;
    return bounded.value;
  };
  const experiment = experimentAttributes(record.attributes);
  const retained = genAiEvent
    ? genAiAttributes(record.attributes)
    : retainedAttributes(record.attributes);
  const body = boundedBody(
    record.body,
    genAiEvent ? MAX_GEN_AI_CONTENT_BYTES : MAX_ATTRIBUTE_BYTES,
  );
  const eventId = text(attrString(record.attributes, RATEL.eventId));
  const serviceName = text(attrString(record.resourceAttributes, "service.name"));
  const recordOccurredAt = occurredAt(record, receivedAt);
  const catalogDefinition = record.catalogDefinition
    ? toCatalogDefinition(record.catalogDefinition, recordOccurredAt)
    : undefined;

  return {
    id: deterministicEventId(
      projectId,
      eventId ??
        [
          "log",
          record.traceId ?? "-",
          record.spanId ?? "-",
          record.eventName,
          record.timeUnixNano,
          contentHash(record.attributes),
          // A per-message `gen_ai` record carries its message in the body, so
          // two of one span at one time differ only there. Ratel ids stay as
          // they were.
          ...(genAiEvent ? [contentHash(record.body)] : []),
        ].join(":"),
    ),
    projectId,
    eventId,
    sourceId: serviceName,
    ingestSource: "otlp" as const,
    occurredAt: recordOccurredAt,
    eventName: text(record.eventName) ?? "",
    traceId: record.traceId,
    spanId: record.spanId,
    severityNumber: intColumn(record.severityNumber) ?? 0,
    serviceName,
    scopeName: text(record.scopeName),
    body: body.value,
    experimentName: text(attrString(record.attributes, RATEL_EXPERIMENT.id)),
    experimentArm: text(attrString(record.attributes, RATEL_EXPERIMENT.arm)),
    experimentRole: text(attrString(record.attributes, RATEL_EXPERIMENT.role)),
    experimentSelectionId: text(attrString(record.attributes, RATEL_EXPERIMENT.selectionId)),
    experimentAttrs: experiment.attributes,
    attributes: retained.attributes,
    attrsTruncated: scalarTruncated || retained.truncated || experiment.truncated || body.truncated,
    ...(catalogDefinition ? { catalogDefinition } : {}),
  } satisfies OtelLogRow;
}

function toCatalogDefinition(
  definition: NonNullable<DecodedLogRecord["catalogDefinition"]>,
  lastSeenAt: Date,
): OtelLogRow["catalogDefinition"] {
  const entryId = stripNul(definition.entryId);
  const name = stripNul(definition.name);
  if (
    [...entryId].length > MAX_CATALOG_IDENTITY_CHARS ||
    [...name].length > MAX_CATALOG_IDENTITY_CHARS
  ) {
    return undefined;
  }
  return {
    ...definition,
    entryId,
    name,
    description: boundedString(definition.description, MAX_METADATA_BYTES).value,
    tags: definition.tags.map(stripNul),
    inputSchema: sanitizeJsonValue(definition.inputSchema).value,
    outputSchema: sanitizeJsonValue(definition.outputSchema).value,
    searchableDescription: boundedString(definition.searchableDescription, MAX_METADATA_BYTES)
      .value,
    contentHash: boundedString(definition.contentHash, MAX_METADATA_BYTES).value,
    lastSeenAt,
  };
}

function occurredAt(record: DecodedLogRecord, receivedAt: Date | undefined): Date {
  const unixMs =
    validTime(record.timeUnixMs) ??
    validTime(record.observedTimeUnixMs) ??
    receivedAt?.getTime() ??
    Date.now();
  return new Date(unixMs);
}

function validTime(value: number): number | null {
  return Number.isFinite(value) && value > 0 && value <= MAX_DATE_MS ? value : null;
}

function intColumn(value: number | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const integer = Math.trunc(value);
  return integer >= 0 && integer <= 2_147_483_647 ? integer : null;
}

function experimentAttributes(attributes: AttrMap): {
  attributes: AttrMap;
  truncated: boolean;
} {
  return boundedAttributes(
    Object.fromEntries(
      Object.entries(attributes).filter(([key]) =>
        stripNul(key).startsWith(RATEL_EXPERIMENT.prefix),
      ),
    ),
  );
}

function retainedAttributes(attributes: AttrMap): {
  attributes: AttrMap;
  truncated: boolean;
} {
  return boundedAttributes(
    Object.fromEntries(
      Object.entries(attributes).filter(([key]) => {
        const sanitizedKey = stripNul(key);
        return (
          SAFE_ATTRIBUTE_KEYS.has(sanitizedKey) ||
          ((sanitizedKey.startsWith("gen_ai.") || sanitizedKey.startsWith("ratel.")) &&
            !CONTENT_ATTRIBUTE_KEYS.has(sanitizedKey) &&
            !LEGACY_INDEXED_CONTENT_ATTRIBUTE_PATTERN.test(sanitizedKey))
        );
      }),
    ),
  );
}

/** A `gen_ai` event keeps its `gen_ai.*` keys, content included: the content is why it is kept. */
function genAiAttributes(attributes: AttrMap): {
  attributes: AttrMap;
  truncated: boolean;
} {
  return boundedAttributes(
    Object.fromEntries(
      Object.entries(attributes).filter(([key]) => {
        const sanitizedKey = stripNul(key);
        return SAFE_ATTRIBUTE_KEYS.has(sanitizedKey) || sanitizedKey.startsWith("gen_ai.");
      }),
    ),
    MAX_GEN_AI_CONTENT_BYTES,
  );
}

function boundedAttributes(
  attributes: AttrMap,
  maxBytes = MAX_ATTRIBUTE_BYTES,
): {
  attributes: AttrMap;
  truncated: boolean;
} {
  const retained: AttrMap = {};
  let retainedCount = 0;
  let retainedBytes = 2;
  let truncated = false;

  for (const [key, value] of Object.entries(attributes)) {
    const sanitizedKey = stripNul(key);
    const sanitizedValue = sanitizeJsonValue(value);
    truncated ||= sanitizedKey.length !== key.length || sanitizedValue.sanitized;
    const serializedValue = JSON.stringify(sanitizedValue.value);
    if (serializedValue === undefined) {
      truncated = true;
      continue;
    }
    const entryBytes =
      (retainedCount > 0 ? 1 : 0) +
      Buffer.byteLength(JSON.stringify(sanitizedKey), "utf8") +
      1 +
      Buffer.byteLength(serializedValue, "utf8");
    if (retainedBytes + entryBytes <= maxBytes) {
      retained[sanitizedKey] = sanitizedValue.value;
      retainedCount += 1;
      retainedBytes += entryBytes;
    } else {
      truncated = true;
    }
  }

  return { attributes: retained, truncated };
}

/**
 * Cap the free-form `body` the same way attributes are capped, so a single
 * record can't push a multi-megabyte body into jsonb. A scalar string
 * keeps a UTF-8-safe prefix; any richer shape degrades to its truncated JSON
 * text (still valid jsonb) once it exceeds the attribute budget.
 */
function boundedBody(value: AttrValue, maxBytes: number): { value: AttrValue; truncated: boolean } {
  const sanitized = sanitizeJsonValue(value);
  const serialized = JSON.stringify(sanitized.value);
  if (serialized === undefined) {
    return { value: null, truncated: true };
  }
  if (Buffer.byteLength(serialized, "utf8") <= maxBytes) {
    return { value: sanitized.value, truncated: sanitized.sanitized };
  }
  // Oversized: keep a UTF-8-safe prefix of the source text (the raw string, or
  // the JSON rendering of a richer shape), shrinking until the *stored* jsonb
  // string — enclosing quotes and escapes included — fits the attribute budget.
  const source = typeof sanitized.value === "string" ? sanitized.value : serialized;
  let prefix = boundedString(source, maxBytes).value;
  while (prefix.length > 0 && Buffer.byteLength(JSON.stringify(prefix), "utf8") > maxBytes) {
    prefix = boundedString(prefix, Buffer.byteLength(prefix, "utf8") - 128).value;
  }
  return { value: prefix, truncated: true };
}

function boundedString(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const sanitized = stripNul(value);
  const encoded = Buffer.from(sanitized, "utf8");
  if (encoded.byteLength <= maxBytes) {
    return { value: sanitized, truncated: sanitized.length !== value.length };
  }

  let end = maxBytes;
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1;
  return {
    value: encoded.subarray(0, end).toString("utf8"),
    truncated: true,
  };
}

function sanitizeJsonValue(value: AttrValue): {
  value: AttrValue;
  sanitized: boolean;
} {
  if (typeof value === "string") {
    const sanitized = stripNul(value);
    return { value: sanitized, sanitized: sanitized.length !== value.length };
  }
  if (Array.isArray(value)) {
    const items = value.map(sanitizeJsonValue);
    return {
      value: items.map((item) => item.value),
      sanitized: items.some((item) => item.sanitized),
    };
  }
  if (value !== null && typeof value === "object") {
    let sanitized = false;
    const entries = Object.entries(value).map(([key, item]) => {
      const sanitizedKey = stripNul(key);
      const sanitizedItem = sanitizeJsonValue(item);
      sanitized ||= sanitizedKey.length !== key.length || sanitizedItem.sanitized;
      return [sanitizedKey, sanitizedItem.value] as const;
    });
    return { value: Object.fromEntries(entries), sanitized };
  }
  return { value, sanitized: false };
}

function stripNul(value: string): string {
  return value.replaceAll("\0", "");
}
