import type { NewOtelSpan } from "@/lib/ingest/otlp/schema";
import { type BatchPrices, costFor, PRICES_UNKNOWN } from "@/lib/ingest/pricing";
import { deterministicEventId, MAX_QUERY } from "@/lib/ingest/trace-events/parse";
import { attrNumber, attrString } from "./anyvalue";
import { AGENT_DIMENSION, GEN_AI, RATEL, RATEL_EXPERIMENT, RATEL_SEARCH } from "./constants";
import {
  type DetectSource,
  type HarnessId,
  type McpRole,
  type McpTransport,
  NO_DIMENSIONS,
  NO_SPAN_DIMENSIONS,
  type SpanDimensionsById,
} from "./dimensions";
import { emitterCostUsd } from "./emitter-cost";
import { type AgentSpanDedupe, isAnchor, isDedupedAgentSpan, isExecuteTool } from "./group";
import {
  type StoredSpanEvent,
  type StoredSpanLink,
  storedSpanEvents,
  storedSpanLinks,
} from "./span-events";
import type { AttrMap, AttrValue, DecodedSpan } from "./types";

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
  /** Entity dimensions (RC-772), from `lib/otlp/dimensions`. */
  agentKey: string | null;
  agentSource: DetectSource | null;
  callerAgentKey: string | null;
  mcpServer: string | null;
  mcpServerSource: DetectSource | null;
  mcpRole: McpRole | null;
  mcpSessionId: string | null;
  /** The span's events and links (AOBS-7); null when it has none or they are not stored. */
  events: StoredSpanEvent[] | null;
  links: StoredSpanLink[] | null;
  /**
   * Who called the MCP server (RC-773). No IP: ingest reads its country
   * (`geoCountry`) and drops it (RP-138), so no row keeps a caller's IP.
   */
  harness: HarnessId | null;
  harnessRaw: string | null;
  harnessVersion: string | null;
  harnessSource: DetectSource | null;
  geoCountry: string | null;
  mcpTransport: McpTransport | null;
  mcpProtocolVersion: string | null;
}

const MAX_ATTRIBUTE_BYTES = 16 * 1024;
const MAX_METADATA_BYTES = 1024;
const MAX_DATE_MS = 8_640_000_000_000_000;
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/i;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/i;
const ZERO_SPAN_ID = "0000000000000000";
const MCP_SESSION_ID_KEY = "mcp.session.id";
/** The keys a tool span keeps, in the order the size bound keeps them. */
const TOOL_CONTENT_KEYS = [
  MCP_SESSION_ID_KEY,
  GEN_AI.toolCallArguments,
  GEN_AI.toolCallResult,
] as const;
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
  // AOBS-7: the question a coding agent asked a person (a `ratel.human.wait` event).
  "ratel.wait.question",
]);
/**
 * MCP keys are kept so a stored span still says what it was (RC-773): an
 * `initialize` row is found by its `mcp.method.name`. The caller's address and
 * User-Agent are not, and no column keeps the IP either (RP-138): only its
 * country (`geo_country`).
 */
const SAFE_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
  "error.type",
  "server.address",
  // AOBS-5: the MCP server of a tool call, a name and no content.
  AGENT_DIMENSION.mcpServer,
  "mcp.method.name",
  "mcp.protocol.version",
  "mcp.client.name",
  "mcp.client.version",
  "mcp.server.name",
  "mcp.server.version",
  "network.transport",
]);
/**
 * Resource keys a span row keeps: the environment facet in `lib/traces/queries.ts` reads them from `attributes`.
 * The legacy `deployment.environment` is kept only without the `.name` key.
 */
const ENVIRONMENT_KEY = "deployment.environment.name";
const LEGACY_ENVIRONMENT_KEY = "deployment.environment";
const SERVICE_VERSION_KEY = "service.version";
const SANDBOX_ATTRIBUTE_PREFIXES = ["ratel.sandbox.", "ratel.replay."] as const;
const LEGACY_INDEXED_CONTENT_ATTRIBUTE_PATTERN = /^gen_ai\.(?:prompt|completion)\.\d+(?:\.|$)/;

export interface OtelSpanRowOptions {
  /** The project's price book (RC-482); absent, the current built-in prices; unknown, no cost. */
  prices?: BatchPrices;
  /**
   * The export's span dimensions, which ingest derives one time
   * (`lib/otlp/dimensions`). They are never derived here: without them, or for
   * a span they do not hold, the row's dimension columns are null.
   */
  dimensions?: SpanDimensionsById;
  /**
   * The attribute keys the project's pivots read (RC-883):
   * each is kept, the span's value winning over the resource's. Absent or
   * empty, the rows are as before.
   */
  pivotKeys?: ReadonlySet<string>;
}

/** A pivot value is a group name: longer strings are cut to this many bytes. */
export const MAX_PIVOT_VALUE_BYTES = 256;

export function toOtelSpanRows(
  projectId: string,
  spans: DecodedSpan[],
  dedupe?: AgentSpanDedupe,
  options: OtelSpanRowOptions = {},
): OtelSpanRow[] {
  const normalizedSpans = spans.map(normalizeParentSpanId);
  const dimensions = options.dimensions ?? NO_SPAN_DIMENSIONS;
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
    // The book first; a call it has no price for takes the emitter's own
    // cost (AOBS-3). Only a span with token usage:
    // a run total on an agent root would count its calls twice.
    const cost =
      options.prices === PRICES_UNKNOWN || !hasCostUsage
        ? null
        : (costFor(
            model,
            {
              input_tokens: inputTokens,
              output_tokens: outputTokens,
              cached_tokens: cachedTokens,
              cache_write_tokens: intColumn(attrNumber(span.attributes, GEN_AI.usageCacheCreation)),
            },
            options.prices,
          ) ?? emitterCostUsd(span.attributes));
    const retained = retainedAttributes(
      span.attributes,
      {
        ...environmentAttributes(span),
        ...sandboxAttributes(span.attributes),
        ...pivotAttributes(span, options.pivotKeys),
      },
      keptContent(span),
    );
    const experiment = experimentAttributes(span);
    const entity = dimensions.get(span.spanId) ?? NO_DIMENSIONS;
    // Each span's events and links (AOBS-7).
    const events = storedSpanEvents(span);
    const links = storedSpanLinks(span);

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
      attrsTruncated:
        scalarTruncated ||
        retained.truncated ||
        experiment.truncated ||
        events.truncated ||
        links.truncated,
      agentKey: entity.agentKey,
      agentSource: entity.agentSource,
      callerAgentKey: entity.callerAgentKey,
      mcpServer: entity.mcpServer,
      mcpServerSource: entity.mcpServerSource,
      mcpRole: entity.mcpRole,
      mcpSessionId: entity.mcpSessionId,
      events: events.value,
      links: links.value,
      harness: entity.client.harness,
      harnessRaw: text(entity.client.harnessRaw),
      harnessVersion: text(entity.client.harnessVersion),
      harnessSource: entity.client.harnessSource,
      geoCountry: entity.client.geoCountry,
      mcpTransport: entity.client.mcpTransport,
      mcpProtocolVersion: text(entity.client.mcpProtocolVersion),
    } satisfies NewOtelSpan;
  });
}

/**
 * The content keys a row keeps: an agent root's ask (RC-740), or an
 * `execute_tool` span's MCP session id, tool arguments and result (RC-725).
 * Tool-only traces make no `events` row, so the `otel_spans` row is the one
 * place they can stay.
 */
function keptContent(span: DecodedSpan): AttrMap {
  if (isAgentAskRoot(span))
    return { [GEN_AI.inputMessages]: span.attributes[GEN_AI.inputMessages]! };
  if (!isExecuteTool(span)) return {};
  const out: AttrMap = {};
  for (const key of TOOL_CONTENT_KEYS) {
    const value = span.attributes[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * A top-level `invoke_agent` span that carries its run's ask as
 * `gen_ai.input.messages` (Ratel's own backend jobs, RC-722). Its row keeps the
 * ask (RC-740). Model calls keep their content in `events.payload`; this root
 * has no event, so its row is the one place the ask can stay.
 */
function isAgentAskRoot(span: DecodedSpan): boolean {
  const parent = span.parentSpanId;
  return (
    (parent === null || parent === ZERO_SPAN_ID) &&
    attrString(span.attributes, GEN_AI.operationName) === "invoke_agent" &&
    typeof span.attributes[GEN_AI.inputMessages] === "string"
  );
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

/** A key `otel_spans` keeps: a safe key, or a `gen_ai.*` / `ratel.*` key that carries no content. */
export function isContentFreeAttributeKey(key: string): boolean {
  return (
    SAFE_ATTRIBUTE_KEYS.has(key) ||
    ((key.startsWith("gen_ai.") || key.startsWith("ratel.")) &&
      !CONTENT_ATTRIBUTE_KEYS.has(key) &&
      !LEGACY_INDEXED_CONTENT_ATTRIBUTE_PATTERN.test(key))
  );
}

function stripContentAttributes(attributes: AttrMap): AttrMap {
  return Object.fromEntries(
    Object.entries(attributes).filter(([key]) => isContentFreeAttributeKey(key)),
  );
}

/** The environment and service version, a span attribute winning over the resource's. */
function environmentAttributes(span: DecodedSpan): AttrMap {
  const read = (key: string) =>
    attrString(span.attributes, key) ?? attrString(span.resourceAttributes, key);
  const out: AttrMap = {};
  const environment = read(ENVIRONMENT_KEY);
  const legacy = environment === undefined ? read(LEGACY_ENVIRONMENT_KEY) : undefined;
  const version = read(SERVICE_VERSION_KEY);
  if (environment !== undefined) out[ENVIRONMENT_KEY] = environment;
  if (legacy !== undefined) out[LEGACY_ENVIRONMENT_KEY] = legacy;
  if (version !== undefined) out[SERVICE_VERSION_KEY] = version;
  return out;
}

/**
 * The configured pivot keys of the span (RC-883): scalar values only, the
 * span's winning over the resource's, strings cut to
 * {@link MAX_PIVOT_VALUE_BYTES}. They go in `extra`, so the 16KB bound still
 * holds.
 */
function pivotAttributes(span: DecodedSpan, keys: ReadonlySet<string> | undefined): AttrMap {
  const out: AttrMap = {};
  if (!keys || keys.size === 0) return out;
  for (const key of keys) {
    const value = pivotValue(span.attributes[key]) ?? pivotValue(span.resourceAttributes[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function pivotValue(value: AttrValue | undefined): string | number | boolean | undefined {
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return boundedString(value, MAX_PIVOT_VALUE_BYTES).value;
}

/**
 * The sandbox and replay keys (spec §10): the playground and Open in sandbox query
 * them, so the size bound keeps them before other span attributes.
 */
function sandboxAttributes(attributes: AttrMap): AttrMap {
  return Object.fromEntries(
    Object.entries(attributes).filter(([key]) =>
      SANDBOX_ATTRIBUTE_PREFIXES.some((prefix) => key.startsWith(prefix)),
    ),
  );
}

/**
 * `extra` goes first, so the size bound drops span attributes before it.
 * `content` (an agent root's kept ask, a tool span's kept session and
 * payloads) goes last: content too big for the bound is dropped before any
 * content-free key, and a tool result before its arguments.
 */
function retainedAttributes(
  attributes: AttrMap,
  extra: AttrMap,
  content: AttrMap,
): {
  attributes: AttrMap;
  truncated: boolean;
} {
  return boundedAttributes({ ...extra, ...stripContentAttributes(attributes), ...content });
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
