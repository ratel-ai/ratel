/**
 * Internal, wire-agnostic shapes the OTLP mapper works with. Both transports —
 * protobuf (`application/x-protobuf`, what the OTLP SDK exporters send) and
 * OTLP/JSON (`application/json`) — decode into these same `DecodedSpan`s, so
 * `group.ts` / `reconstruct.ts` never see the difference. Ids are hex strings and
 * times are unix-epoch milliseconds by the time a span reaches here.
 */

/** A JSON-ish attribute value after an OTLP `AnyValue` is flattened to plain JS. */
export type AttrValue =
  | string
  | number
  | boolean
  | null
  | AttrValue[]
  | { [key: string]: AttrValue };

/** A span/resource/event attribute set, keyed by attribute name (e.g. `gen_ai.usage.input_tokens`). */
export type AttrMap = Record<string, AttrValue>;

/** One span event (e.g. `gen_ai.client.inference.operation.details`). */
export interface DecodedEvent {
  name: string;
  timeUnixMs: number;
  attributes: AttrMap;
}

export type CatalogKind = "tool" | "skill" | "fact";

/** Validated content carried by one `ratel.catalog.definition` record. */
export interface DecodedCatalogDefinition {
  kind: CatalogKind;
  entryId: string;
  name: string;
  description: string;
  tags: string[];
  inputSchema: AttrValue;
  outputSchema: AttrValue;
  searchableDescription: string;
  searchableDescriptionOverridden: boolean;
  useCloudDefinitions: boolean;
  contentHash: string;
}

/** A single OTLP span, normalized: hex ids, epoch-ms times, JS attribute maps. */
export interface DecodedSpan {
  traceId: string;
  spanId: string;
  /** Hex parent id, or null for a root span. */
  parentSpanId: string | null;
  name: string;
  /** OTLP SpanKind (0 unspecified · 1 internal · 2 server · 3 client · 4 producer · 5 consumer). */
  kind: number;
  startUnixMs: number;
  endUnixMs: number;
  attributes: AttrMap;
  events: DecodedEvent[];
  /** OTLP Status code (0 unset · 1 ok · 2 error). */
  statusCode: number;
  /** Resource-level attributes from the owning ResourceSpans (e.g. `service.name`). */
  resourceAttributes: AttrMap;
  /** Instrumentation scope name, if any. */
  scopeName: string | null;
}

/** A single OTLP log record normalized for persistence mapping. */
export interface DecodedLogRecord {
  eventName: string;
  /** Original unix-nanoseconds string, retained for deterministic identity. */
  timeUnixNano: string;
  timeUnixMs: number;
  /** Original observed unix-nanoseconds string, retained for fallback identity/debugging. */
  observedTimeUnixNano: string;
  observedTimeUnixMs: number;
  traceId: string | null;
  spanId: string | null;
  severityNumber: number;
  severityText: string | null;
  body: AttrValue;
  attributes: AttrMap;
  catalogDefinition?: DecodedCatalogDefinition | null;
  resourceAttributes: AttrMap;
  scopeName: string | null;
}

/* --- Raw OTLP wire shapes (post-decode, camelCase) ----------------------------
   Both protobufjs `toObject` and OTLP/JSON produce camelCase keys, so a single
   loose typing covers both. Only the fields the mapper reads are named. */

export interface RawAnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string | number;
  doubleValue?: number;
  arrayValue?: { values?: RawAnyValue[] };
  kvlistValue?: { values?: RawKeyValue[] };
  bytesValue?: string | Uint8Array | number[];
}

export interface RawKeyValue {
  key?: string;
  value?: RawAnyValue;
}

export interface RawSpanEvent {
  name?: string;
  timeUnixNano?: string | number;
  attributes?: RawKeyValue[];
}

export interface RawSpan {
  traceId?: string | Uint8Array | number[];
  spanId?: string | Uint8Array | number[];
  parentSpanId?: string | Uint8Array | number[];
  name?: string;
  kind?: number;
  startTimeUnixNano?: string | number;
  endTimeUnixNano?: string | number;
  attributes?: RawKeyValue[];
  events?: RawSpanEvent[];
  status?: { code?: number; message?: string };
}

export interface RawScopeSpans {
  scope?: { name?: string };
  spans?: RawSpan[];
}

export interface RawResourceSpans {
  resource?: { attributes?: RawKeyValue[] };
  scopeSpans?: RawScopeSpans[];
}

export interface IExportTraceServiceRequest {
  resourceSpans?: RawResourceSpans[];
}

export interface RawLogRecord {
  timeUnixNano?: string | number;
  observedTimeUnixNano?: string | number;
  severityNumber?: number;
  severityText?: string;
  body?: RawAnyValue;
  attributes?: RawKeyValue[];
  traceId?: string | Uint8Array | number[];
  spanId?: string | Uint8Array | number[];
  eventName?: string;
}

export interface RawScopeLogs {
  scope?: { name?: string };
  logRecords?: RawLogRecord[];
}

export interface RawResourceLogs {
  resource?: { attributes?: RawKeyValue[] };
  scopeLogs?: RawScopeLogs[];
}

export interface IExportLogsServiceRequest {
  resourceLogs?: RawResourceLogs[];
}

/* --- Grouping output ---------------------------------------------------------- */

/** An LLM-call anchor span plus the sibling spans/events that enrich it. */
export interface GroupedCall {
  /** The `gen_ai` client span carrying model/usage/timing. */
  anchor: DecodedSpan;
  /** The `gen_ai.client.inference.operation.details` event on the anchor, if content was captured. */
  detailsEvent: DecodedEvent | null;
  /** Sibling `execute_tool` spans in the same trace — tool-call signal for `tools_used`. */
  toolSpans: DecodedSpan[];
}
