import { createHash } from "node:crypto";
import { categorize } from "@/lib/ingest/categorize";
import type { CloudEvent, CloudMessage, CloudToolDef, CloudUsage } from "@/lib/ingest/cloud-schema";
import type { EventWithMetric } from "@/lib/ingest/otlp/queries";
import { costFor } from "@/lib/ingest/pricing";
import { attrBool, attrNumber, attrString, attrStringArray, attrStructured } from "./anyvalue";
import { GEN_AI } from "./constants";
import { mapMessages, mapToolDefinitions, systemFromInstructions } from "./content";
import type { AttrMap, DecodedSpan, GroupedCall } from "./types";

/**
 * Reconstruct the internal `CloudEvent` from a grouped OTLP call, so the existing
 * `categorize()` + `costFor()` pipeline runs unchanged. Header/usage/timing map
 * from `gen_ai.*` span attributes (always present); `system`/`messages`/`tools`
 * come from the opt-in inference-details event when present, falling back to the
 * same keys on the anchor span's attributes (SPAN_ONLY-mode emitters and Mastra's
 * otel-exporter put content there), and `gen_ai.tool.definitions`; a call with no
 * captured content degrades to a totals-only event (the categorizer then
 * attributes all input tokens to `user_input`).
 */

// Plausible-timestamp bounds, lifted verbatim from the retired events route: a
// span whose start clock is broken buckets by receipt time instead of an unviewed
// window.
const MIN_TS_MS = Date.parse("2020-01-01T00:00:00Z");
const FUTURE_SKEW_MS = 2 * 86_400_000; // tolerate ~2 days of clock skew

const VALID_FINISH = new Set(["stop", "length", "tool_call", "content_filter", "refusal"]);
const FINISH_ALIASES: Record<string, string> = {
  tool_calls: "tool_call",
  function_call: "tool_call",
  max_tokens: "length",
  end_turn: "stop",
  stop_sequence: "stop",
};

function intOrZero(n: number | undefined): number {
  return n != null && Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

function mapUsage(a: AttrMap): CloudUsage | undefined {
  const input = attrNumber(a, GEN_AI.usageInputTokens);
  const output = attrNumber(a, GEN_AI.usageOutputTokens);
  const cached = attrNumber(a, GEN_AI.usageCacheRead);
  const reasoning = attrNumber(a, GEN_AI.usageReasoning);
  if (
    input === undefined &&
    output === undefined &&
    cached === undefined &&
    reasoning === undefined
  ) {
    return undefined;
  }
  return {
    input_tokens: intOrZero(input),
    output_tokens: intOrZero(output),
    ...(cached !== undefined ? { cached_tokens: intOrZero(cached) } : {}),
    ...(reasoning !== undefined ? { reasoning_tokens: intOrZero(reasoning) } : {}),
  };
}

function mapParams(a: AttrMap): CloudEvent["params"] {
  const temperature = attrNumber(a, GEN_AI.requestTemperature);
  const top_p = attrNumber(a, GEN_AI.requestTopP);
  const max_tokens = attrNumber(a, GEN_AI.requestMaxTokens);
  const stop = attrStringArray(a, GEN_AI.requestStopSequences);
  if (temperature === undefined && top_p === undefined && max_tokens === undefined && !stop) {
    return undefined;
  }
  return {
    ...(temperature !== undefined ? { temperature } : {}),
    ...(top_p !== undefined ? { top_p } : {}),
    ...(max_tokens !== undefined ? { max_tokens } : {}),
    ...(stop ? { stop } : {}),
  };
}

function mapFinishReason(a: AttrMap): CloudEvent["finish_reason"] {
  const first = attrStringArray(a, GEN_AI.finishReasons)?.[0];
  if (!first) return undefined;
  const mapped = FINISH_ALIASES[first] ?? first;
  return VALID_FINISH.has(mapped) ? (mapped as CloudEvent["finish_reason"]) : undefined;
}

/** Tool names actually invoked, from the sibling `execute_tool` spans. */
function toolSpanNames(toolSpans: DecodedSpan[]): string[] {
  const names: string[] = [];
  for (const t of toolSpans) {
    const name = attrString(t.attributes, GEN_AI.toolName);
    if (name) names.push(name);
  }
  return names;
}

/**
 * The call arguments an `execute_tool` span carries (span-attribute content —
 * emitters with the capture gate in a span mode, and Mastra's otel-exporter
 * unconditionally, put them there). `{}` when absent or not an object.
 */
function toolSpanArguments(span: DecodedSpan): Record<string, unknown> {
  const v = attrStructured(span.attributes, GEN_AI.toolCallArguments);
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return {};
}

/**
 * Assemble `tools[]` + patch `messages[]` so the categorizer can compute the
 * used/unused split:
 * - offered catalog present (`gen_ai.tool.definitions`) → full fidelity.
 * - otherwise synthesize a def per *called* tool (from content + execute_tool
 *   spans); all are "used", tools_unused = 0 (the honest answer without a catalog).
 * Called tools not represented in `messages` get a synthetic assistant tool_call
 * so `categorize()`'s call-count scan sees them.
 */
function assembleTools(
  toolDefsRaw: ReturnType<typeof attrStructured>,
  toolSpans: DecodedSpan[],
  messages: CloudMessage[],
  contentCalled: Set<string>,
): CloudToolDef[] {
  const catalog = mapToolDefinitions(toolDefsRaw);
  const spanNames = toolSpanNames(toolSpans);

  // Tools called via execute_tool spans but absent from the captured messages get a
  // synthetic assistant tool_call so the categorizer counts them as used. The span
  // carries the real arguments when the emitter captures content on spans.
  const extra = toolSpans
    .map((t) => ({ name: attrString(t.attributes, GEN_AI.toolName), args: toolSpanArguments(t) }))
    .filter(
      (t): t is { name: string; args: Record<string, unknown> } =>
        !!t.name && !contentCalled.has(t.name),
    );
  if (extra.length > 0) {
    messages.push({
      role: "assistant",
      content: extra.map(({ name, args }) => ({
        type: "tool_call" as const,
        id: "",
        name,
        arguments: args,
      })),
    });
  }

  if (catalog.length > 0) return catalog;

  // No offered catalog: synthesize a minimal def per distinct called tool.
  const called = new Set<string>([...contentCalled, ...spanNames]);
  return [...called].map((name) => ({ name, parameters: {} }));
}

/** Reconstruct a `CloudEvent` from a grouped OTLP call. */
export function toCloudEvent(call: GroupedCall): CloudEvent {
  const a = call.anchor.attributes;
  const details = call.detailsEvent?.attributes ?? {};

  // Content prefers the opt-in details event (the sanctioned channel). Ecosystem
  // instrumentations that never emit it (e.g. Mastra's otel-exporter, or any
  // emitter in SPAN_ONLY capture mode) put the same v1.42.0 message JSON on the
  // anchor span's attributes — fall back to those so their content still counts.
  const content = mapMessages(
    attrStructured(details, GEN_AI.inputMessages) ?? attrStructured(a, GEN_AI.inputMessages),
    attrStructured(details, GEN_AI.outputMessages) ?? attrStructured(a, GEN_AI.outputMessages),
  );
  const messages: CloudMessage[] = content.messages;

  const systemFromEvent = systemFromInstructions(
    attrStructured(details, GEN_AI.systemInstructions) ??
      attrStructured(a, GEN_AI.systemInstructions),
  );
  const system = [systemFromEvent, content.system].filter(Boolean).join("\n") || undefined;

  // The offered tool catalog may ride the anchor span or the details event.
  const toolDefsRaw =
    attrStructured(a, GEN_AI.toolDefinitions) ?? attrStructured(details, GEN_AI.toolDefinitions);
  const tools = assembleTools(toolDefsRaw, call.toolSpans, messages, content.calledNames);

  // The categorizer needs at least one message (its "current turn" anchor); a
  // content-absent call gets an empty placeholder so all input folds to user_input.
  if (messages.length === 0) messages.push({ role: "user", content: "" });

  const latencyMs = Math.max(0, Math.round(call.anchor.endUnixMs - call.anchor.startUnixMs));
  const usage = mapUsage(a);
  const params = mapParams(a);
  const finish = mapFinishReason(a);
  const stream = attrBool(a, GEN_AI.requestStream);

  return {
    provider: attrString(a, GEN_AI.providerName) || "unknown",
    model: attrString(a, GEN_AI.responseModel) || attrString(a, GEN_AI.requestModel) || "unknown",
    ts: new Date(call.anchor.startUnixMs).toISOString(),
    ...(stream !== undefined ? { stream } : {}),
    latency_ms: latencyMs,
    ...(system ? { system } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    messages,
    ...(params ? { params } : {}),
    ...(usage ? { usage } : {}),
    ...(finish ? { finish_reason: finish } : {}),
  };
}

/**
 * Stable idempotency key: the provider-assigned response id when present (survives
 * re-instrumentation), else the span id (BatchSpanProcessor retries reuse it),
 * else trace id + start. Replaces the old content hash; the
 * `events(project_id, dedupe_hash)` unique index is unchanged.
 */
export function otlpDedupeHash(call: GroupedCall): string {
  const a = call.anchor.attributes;
  const id =
    attrString(a, GEN_AI.responseId) ||
    call.anchor.spanId ||
    `${call.anchor.traceId}:${call.anchor.startUnixMs}`;
  return createHash("sha256").update(id).digest("hex");
}

/** Plausible occurred-at, or null (→ receipt time) for a broken clock. */
export function plausibleOccurredAt(startUnixMs: number): Date | null {
  if (startUnixMs < MIN_TS_MS || startUnixMs > Date.now() + FUTURE_SKEW_MS) return null;
  return new Date(startUnixMs);
}

/**
 * Turn a grouped OTLP call into the raw event + derived metrics row, reusing
 * `categorize()` and `costFor()` exactly as the retired events route did.
 *
 * The row keeps the anchor span's trace and span id, so a captured reply joins
 * its turn (`turn_key = otlp:<trace id>`) exactly; the dedupe hash cannot do
 * that once it is keyed on `gen_ai.response.id`. An empty id (a span the
 * exporter sent without one) is stored as null, never as "".
 */
export function toRow(projectId: string, call: GroupedCall): EventWithMetric {
  const e = toCloudEvent(call);
  const occurredAt = plausibleOccurredAt(call.anchor.startUnixMs);
  const eventTime = occurredAt ?? new Date();

  const usage = e.usage;
  const inputTokens = usage?.input_tokens ?? null;
  const outputTokens = usage?.output_tokens ?? null;
  const latencyMs = e.latency_ms != null ? Math.round(e.latency_ms) : null;
  const cost = costFor(
    e.model,
    usage && {
      ...usage,
      cache_write_tokens: attrNumber(call.anchor.attributes, GEN_AI.usageCacheCreation),
    },
  );
  const costUsd = cost != null ? cost.toString() : null;

  const m = categorize(e);

  return {
    event: {
      projectId,
      occurredAt,
      provider: e.provider,
      model: e.model,
      stream: e.stream ?? null,
      finishReason: e.finish_reason ?? null,
      latencyMs,
      inputTokens,
      outputTokens,
      cachedTokens: usage?.cached_tokens ?? null,
      reasoningTokens: usage?.reasoning_tokens ?? null,
      costUsd,
      payload: e,
      dedupeHash: otlpDedupeHash(call),
      categorizerVersion: m.categorizerVersion,
      traceId: call.anchor.traceId || null,
      spanId: call.anchor.spanId || null,
    },
    metric: {
      eventTime,
      tokensByCategory: m.tokensByCategory,
      splits: m.splits,
      toolsByName: m.toolsByName,
      toolsTotalCount: m.toolsTotalCount,
      toolsUsedCount: m.toolsUsedCount,
      inputTokens,
      outputTokens,
      costUsd,
      latencyMs,
      categorizerVersion: m.categorizerVersion,
    },
  };
}
