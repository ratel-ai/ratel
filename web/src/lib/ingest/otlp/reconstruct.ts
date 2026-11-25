import { createHash } from "node:crypto";
import { categorize, producedMessages, toolCallBlocks } from "@/lib/ingest/categorize";
import type {
  CloudEvent,
  CloudMessage,
  CloudToolDef,
  CloudUsage,
  ToolCallBlock,
} from "@/lib/ingest/cloud-schema";
import type { EventWithMetric } from "@/lib/ingest/otlp/queries";
import { type BatchPrices, costFor, PRICES_UNKNOWN } from "@/lib/ingest/pricing";
import { attrBool, attrNumber, attrString, attrStringArray, attrStructured } from "./anyvalue";
import { GEN_AI } from "./constants";
import {
  type MappedContent,
  mapMessages,
  mapSettings,
  mapToolDefinitions,
  systemFromInstructions,
} from "./content";
import { emitterCostUsd } from "./emitter-cost";
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

/**
 * What a call's payload keeps beyond the categorizer's input. `captureReply`
 * (RC-280, on at ingest): the call's own reply as `output` and its request
 * settings as `settings`, only on a call that carries content. Off, the
 * payload is exactly as before.
 */
export interface PayloadCapture {
  captureReply?: boolean;
}

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
 * What a tool span of one trace can match when ingest asks if its call is
 * counted already. `countedIds` holds the ids the trace's calls in this batch
 * produced, and the ids of spans counted so far. `presumedIds` holds the history
 * ids this batch has no producer for, and whose producer is in an earlier batch.
 */
interface ToolSpanScope {
  countedIds: Set<string>;
  presumedIds: ReadonlySet<string>;
}

/** The scope of every trace in a batch of calls. */
function toolSpanScopes(
  calls: GroupedCall[],
  contents: MappedContent[],
): Map<string, ToolSpanScope> {
  const byTrace = new Map<string, { start: number; content: MappedContent }[]>();
  calls.forEach((call, i) => {
    const list = byTrace.get(call.anchor.traceId) ?? [];
    list.push({ start: call.anchor.startUnixMs, content: contents[i] });
    byTrace.set(call.anchor.traceId, list);
  });
  const scopes = new Map<string, ToolSpanScope>();
  for (const [traceId, list] of byTrace) {
    list.sort((a, b) => a.start - b.start);
    scopes.set(traceId, traceScope(list.map((c) => c.content)));
  }
  return scopes;
}

/**
 * A history id that no call of the batch produced is presumed counted, unless
 * the call just before the first call that shows it has no output: that call
 * made it, and its emitter did not capture it. Then only the tool span records
 * the call. A call with no content at all says nothing, so it is passed over.
 */
function traceScope(contents: MappedContent[]): ToolSpanScope {
  const withContent = contents.filter((c) => c.messages.length > 0);
  const countedIds = new Set(withContent.flatMap((c) => idsOf(producedBlocks(c))));
  const presumedIds = new Set<string>();
  const seen = new Set<string>();
  withContent.forEach((c, i) => {
    for (const id of idsOf(toolCallBlocks(c.messages.slice(0, c.inputCount)))) {
      if (countedIds.has(id) || seen.has(id)) continue;
      seen.add(id);
      if (
        i === 0 ||
        producedMessages(withContent[i - 1].messages, withContent[i - 1].inputCount).length > 0
      ) {
        presumedIds.add(id);
      }
    }
  });
  return { countedIds, presumedIds };
}

function producedBlocks(content: Pick<MappedContent, "messages" | "inputCount">): ToolCallBlock[] {
  return toolCallBlocks(producedMessages(content.messages, content.inputCount));
}

function historyBlocks({
  messages,
  inputCount,
}: Pick<MappedContent, "messages" | "inputCount">): ToolCallBlock[] {
  return toolCallBlocks(messages.slice(0, inputCount));
}

function idsOf(blocks: ToolCallBlock[]): string[] {
  return blocks.map((b) => b.id).filter(Boolean);
}

/**
 * The call arguments an `execute_tool` span carries (span-attribute content —
 * emitters with the capture gate in a span mode, and Mastra's otel-exporter
 * unconditionally, put them there). `{}` when absent or not an object.
 */
export function toolSpanArguments(span: DecodedSpan): Record<string, unknown> {
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
 * so `categorize()`'s call-count scan sees them. See
 * {@link uncountedToolSpans}: a name only in the input history is an earlier
 * call's, so this call's span for it still counts, unless the span has the id of
 * a counted call. A tool span can group under a later call than the one that
 * produced it, and that producer can be in an earlier batch, so `scope` also
 * presumes history ids counted. A call with no output does not use that: its
 * emitter did not capture output, so no earlier call counted the history ids.
 */
function assembleTools(
  toolDefsRaw: ReturnType<typeof attrStructured>,
  toolSpans: DecodedSpan[],
  content: MappedContent,
  scope: ToolSpanScope,
): CloudToolDef[] {
  const { messages, calledNames: contentCalled } = content;
  const catalog = mapToolDefinitions(toolDefsRaw);
  const spanNames = toolSpanNames(toolSpans);
  const produced = producedBlocks(content);
  const missing = uncountedToolSpans(
    toolSpans,
    produced,
    scope.countedIds,
    producedMessages(messages, content.inputCount).length > 0 ? scope.presumedIds : undefined,
  );

  // Tools called via execute_tool spans but absent from the captured messages get a
  // synthetic assistant tool_call so the categorizer counts them as used. The span
  // carries the real arguments when the emitter captures content on spans.
  const extra = missing
    .map((t) => ({
      name: attrString(t.attributes, GEN_AI.toolName),
      id: attrString(t.attributes, GEN_AI.toolCallId) ?? "",
      args: toolSpanArguments(t),
    }))
    .filter((t): t is { name: string; id: string; args: Record<string, unknown> } => !!t.name);
  if (extra.length > 0) {
    messages.push({
      role: "assistant",
      content: extra.map(({ name, id, args }) => ({
        type: "tool_call" as const,
        id,
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

/**
 * The tool-count rule of scope `produced`, shared by ingest and
 * `backfill:tool-counts`: the tool spans whose call no content counts yet. A span
 * with an id adds nothing when the id is in `countedIds` or `presumedIds`, or when
 * an id-less `produced` block of its name is free (each block covers one span).
 * A span with another id than the call's output is another call, also when the
 * tool name is the same. A span with no id adds nothing when `produced` has its
 * name. Each id it adds joins `countedIds`, so it adds once.
 */
export function uncountedToolSpans(
  toolSpans: DecodedSpan[],
  produced: ToolCallBlock[],
  countedIds: Set<string>,
  presumedIds?: ReadonlySet<string>,
): DecodedSpan[] {
  const names = new Set(produced.map((b) => b.name));
  const freeIdless = new Map<string, number>();
  for (const b of produced) if (!b.id) freeIdless.set(b.name, (freeIdless.get(b.name) ?? 0) + 1);
  return toolSpans.filter((span) => {
    const name = attrString(span.attributes, GEN_AI.toolName);
    const id = attrString(span.attributes, GEN_AI.toolCallId);
    if (!name) return false;
    if (!id) return !names.has(name);
    if (countedIds.has(id) || presumedIds?.has(id)) return false;
    countedIds.add(id);
    const free = freeIdless.get(name) ?? 0;
    if (free === 0) return true;
    freeIdless.set(name, free - 1);
    return false;
  });
}

/** One call of a trace, in time order, as {@link recoverHistoryCalls} reads it. */
export interface HistoryCallContent {
  messages: CloudMessage[];
  /** How many leading `messages` are input. */
  inputCount: number;
  toolSpans: DecodedSpan[];
}

/**
 * The tool-count rule for an emitter that captures no output, shared by ingest and
 * `backfill:tool-counts`: the history tool calls no call produced and no owned tool
 * span recorded, per call, on the first call (in time order) whose input shows them.
 * They count in the metrics only: the payload never changes.
 *
 * Tool calls the first call already shows in its input are not recovered: they come
 * from before these calls.
 *
 * With an id, a call is known when a produced call or an owned tool span has
 * that id. An id-less produced call of the same name (an older synthetic one)
 * also covers it, once. Without an id, a call is recovered only when no produced
 * call or owned tool span has its name; the same name and arguments seen N times
 * in one input stands for N calls. A tool span no call owns counts nowhere, so it
 * does not make a call known.
 *
 * `mayRecover` says if the call at an index may recover what it shows first. The
 * backfill reads the whole trace, so it always may. Ingest reads one batch, so it
 * passes the rule of {@link traceScope}.
 */
export function recoverHistoryCalls(
  calls: HistoryCallContent[],
  mayRecover: (index: number) => boolean = () => true,
): ToolCallBlock[][] {
  const knownIds = new Set<string>();
  const knownNames = new Set<string>();
  const idlessByName = new Map<string, number>();
  for (const span of calls.flatMap((c) => c.toolSpans)) {
    const id = attrString(span.attributes, GEN_AI.toolCallId);
    const name = attrString(span.attributes, GEN_AI.toolName);
    if (id) knownIds.add(id);
    if (name) knownNames.add(name);
  }
  for (const call of calls) {
    for (const b of producedBlocks(call)) {
      knownNames.add(b.name);
      if (b.id) knownIds.add(b.id);
      else idlessByName.set(b.name, (idlessByName.get(b.name) ?? 0) + 1);
    }
  }

  // What the first call already re-sends predates these calls: an earlier turn's
  // calls, counted in that turn's trace, or an earlier batch's.
  const recoveredIdless = new Map<string, number>();
  for (const b of calls[0] ? historyBlocks(calls[0]) : []) {
    if (b.id) knownIds.add(b.id);
    else recoveredIdless.set(idlessKey(b), (recoveredIdless.get(idlessKey(b)) ?? 0) + 1);
  }

  return calls.map((call, index) => {
    const allowed = mayRecover(index);
    const found: ToolCallBlock[] = [];
    const idlessHere = new Map<string, { block: ToolCallBlock; count: number }>();
    for (const b of historyBlocks(call)) {
      if (b.id) {
        if (knownIds.has(b.id)) continue;
        knownIds.add(b.id);
        const idless = idlessByName.get(b.name) ?? 0;
        if (idless > 0) idlessByName.set(b.name, idless - 1);
        else if (allowed) found.push(b);
      } else if (!knownNames.has(b.name)) {
        const key = idlessKey(b);
        const seen = idlessHere.get(key);
        idlessHere.set(key, { block: b, count: (seen?.count ?? 0) + 1 });
      }
    }
    for (const [key, { block, count }] of idlessHere) {
      const already = recoveredIdless.get(key) ?? 0;
      if (allowed) for (let i = already; i < count; i++) found.push(block);
      recoveredIdless.set(key, Math.max(already, count));
    }
    return found;
  });
}

/** Two id-less tool calls with this key are the same call shown again. */
export function idlessKey(b: ToolCallBlock): string {
  return `${b.name}\u0000${JSON.stringify(b.arguments)}`;
}

/** Reconstruct a `CloudEvent` from a grouped OTLP call. */
export function toCloudEvent(call: GroupedCall, capture: PayloadCapture = {}): CloudEvent {
  const content = callContent(call);
  return buildEvent(call, content, traceScope([content]), capture);
}

/** Map one call's input and output messages. */
function callContent(call: GroupedCall): MappedContent {
  const a = call.anchor.attributes;
  const details = call.detailsEvent?.attributes ?? {};

  // Content prefers the opt-in details event (the sanctioned channel). Ecosystem
  // instrumentations that never emit it (e.g. Mastra's otel-exporter, or any
  // emitter in SPAN_ONLY capture mode) put the same v1.42.0 message JSON on the
  // anchor span's attributes — fall back to those so their content still counts.
  return mapMessages(
    attrStructured(details, GEN_AI.inputMessages) ?? attrStructured(a, GEN_AI.inputMessages),
    attrStructured(details, GEN_AI.outputMessages) ?? attrStructured(a, GEN_AI.outputMessages),
  );
}

function buildEvent(
  call: GroupedCall,
  content: MappedContent,
  scope: ToolSpanScope,
  capture: PayloadCapture,
): CloudEvent {
  const a = call.anchor.attributes;
  const details = call.detailsEvent?.attributes ?? {};
  const messages: CloudMessage[] = content.messages;
  // Read before `assembleTools` and the placeholder change `messages`.
  const reply = capture.captureReply ? replyCapture(content, [details, a]) : {};

  const systemFromEvent = systemFromInstructions(
    attrStructured(details, GEN_AI.systemInstructions) ??
      attrStructured(a, GEN_AI.systemInstructions),
  );
  const system = [systemFromEvent, content.system].filter(Boolean).join("\n") || undefined;

  // The offered tool catalog may ride the anchor span or the details event.
  const toolDefsRaw =
    attrStructured(a, GEN_AI.toolDefinitions) ?? attrStructured(details, GEN_AI.toolDefinitions);
  const tools = assembleTools(toolDefsRaw, call.toolSpans, content, scope);

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
    input_message_count: content.inputCount,
    ...(params ? { params } : {}),
    ...reply,
    ...(usage ? { usage } : {}),
    ...(finish ? { finish_reason: finish } : {}),
  };
}

/** The call's own reply and its settings, or nothing for a call with no content. */
function replyCapture(
  content: MappedContent,
  maps: AttrMap[],
): Pick<CloudEvent, "output" | "settings"> {
  if (content.messages.length === 0) return {};
  const output = content.messages.slice(content.inputCount);
  const settings = mapSettings(maps);
  return {
    ...(output.length > 0 ? { output } : {}),
    ...(settings ? { settings } : {}),
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
export function plausibleOccurredAt(startUnixMs: number, receivedAt?: Date): Date | null {
  const now = receivedAt?.getTime() ?? Date.now();
  if (startUnixMs < MIN_TS_MS || startUnixMs > now + FUTURE_SKEW_MS) return null;
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
export function toRow(projectId: string, call: GroupedCall, prices?: BatchPrices): EventWithMetric {
  return rowOf(projectId, call, toCloudEvent(call), [], prices);
}

/**
 * {@link toRow} for one ingest batch, in `calls` order. The calls of a trace see
 * each other's tool calls, so a tool span under a later call is counted the same
 * way as a span under its producer, and a history call of an emitter with no output
 * is recovered once ({@link recoverHistoryCalls}). Only the batch is read, so two
 * limits stay until `backfill:tool-counts` runs: a span that arrives in an earlier
 * batch than its producer counts once more, and a history call that a batch's first
 * call shows first is not recovered.
 *
 * With `receivedAt` (a queued export, ADR-0010), a call with a broken clock occurred then, and the
 * rows do not depend on when they are built. Without it, the call occurred at an unknown time.
 */
export function toRows(
  projectId: string,
  calls: GroupedCall[],
  capture: PayloadCapture = {},
  prices?: BatchPrices,
  receivedAt?: Date,
): EventWithMetric[] {
  const contents = calls.map(callContent);
  const scopes = toolSpanScopes(calls, contents);
  // Read before `buildEvent`: it appends the span calls and a placeholder message.
  const traces = callsWithContentByTrace(calls, contents);
  const hadOutput = contents.map((c) => producedMessages(c.messages, c.inputCount).length > 0);
  const events = calls.map((call, i) =>
    buildEvent(call, contents[i], scopes.get(call.anchor.traceId)!, capture),
  );

  const recovered = new Map<number, ToolCallBlock[]>();
  for (const indexes of traces) {
    const found = recoverHistoryCalls(
      indexes.map((i) => ({
        messages: contents[i].messages,
        inputCount: contents[i].inputCount,
        toolSpans: calls[i].toolSpans,
      })),
      (at) => at > 0 && !hadOutput[indexes[at - 1]],
    );
    indexes.forEach((callIndex, at) => recovered.set(callIndex, found[at]));
  }
  return calls.map((call, i) =>
    rowOf(projectId, call, events[i], recovered.get(i) ?? [], prices, receivedAt),
  );
}

/** Per trace, the indexes of the calls that have content, in time order. */
function callsWithContentByTrace(calls: GroupedCall[], contents: MappedContent[]): number[][] {
  const byTrace = new Map<string, number[]>();
  calls.forEach((call, i) => {
    if (contents[i].messages.length === 0) return;
    byTrace.set(call.anchor.traceId, [...(byTrace.get(call.anchor.traceId) ?? []), i]);
  });
  return [...byTrace.values()].map((indexes) =>
    indexes.sort((a, b) => calls[a].anchor.startUnixMs - calls[b].anchor.startUnixMs),
  );
}

function rowOf(
  projectId: string,
  call: GroupedCall,
  e: CloudEvent,
  recovered: ToolCallBlock[] = [],
  prices?: BatchPrices,
  receivedAt?: Date,
): EventWithMetric {
  const occurredAt = plausibleOccurredAt(call.anchor.startUnixMs, receivedAt) ?? receivedAt ?? null;
  const eventTime = occurredAt ?? new Date();

  const usage = e.usage;
  const inputTokens = usage?.input_tokens ?? null;
  const outputTokens = usage?.output_tokens ?? null;
  const latencyMs = e.latency_ms != null ? Math.round(e.latency_ms) : null;
  // As `toOtelSpanRows`: the book first, then the emitter's own cost (AOBS-3).
  const cost =
    prices === PRICES_UNKNOWN || !usage
      ? null
      : (costFor(
          e.model,
          {
            ...usage,
            cache_write_tokens: attrNumber(call.anchor.attributes, GEN_AI.usageCacheCreation),
          },
          prices,
        ) ?? emitterCostUsd(call.anchor.attributes));
  const costUsd = cost != null ? cost.toString() : null;

  // Every OTLP call counts only the tool calls it produced (ToolCallScope).
  // A recovered call counts in the metrics only, as in the backfill.
  const counted =
    recovered.length > 0
      ? { ...e, messages: [...e.messages, { role: "assistant" as const, content: recovered }] }
      : e;
  const m = categorize(counted, { toolCallScope: "produced" });

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
