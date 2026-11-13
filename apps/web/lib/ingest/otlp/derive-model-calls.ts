import type { ParsedTraceEvent } from "@/lib/ingest/trace-events/parse";
import { attrNumber, attrString } from "./anyvalue";
import {
  AGENT_KEYS,
  ancestorsOf,
  indexSpans,
  resolveUp,
  SESSION_KEYS,
  USER_KEYS,
} from "./attr-resolve";
import { GEN_AI } from "./constants";
import { isSystemPrompt, promptOf } from "./prompt-text";
import { plausibleOccurredAt } from "./reconstruct";
import { isModelRoundTrip, toolMenuOf } from "./span-facts";
import type { DecodedSpan } from "./types";

/**
 * One `otlp_model_call` row per model round trip, for Agent health on the OTel
 * lane: how many times the model was called in a run, its tokens, and (when the
 * customer captures it) the names of the tools it was offered and the user's
 * last message, which names and places workflows.
 *
 * Not a turn event type, so the turn ledger never reads these as steps; the
 * signal run reads them per trace as a side table. Tool names only: tool
 * descriptions and schemas never leave the span, and of the messages only the
 * last user message is kept, capped, and only when the customer captured it.
 */

export const OTLP_MODEL_CALL = "otlp_model_call";

const INPUT_TOKEN_KEYS = [
  GEN_AI.usageInputTokens,
  "llm.token_count.prompt",
  "ai.usage.promptTokens",
] as const;
const OUTPUT_TOKEN_KEYS = [
  GEN_AI.usageOutputTokens,
  "llm.token_count.completion",
  "ai.usage.completionTokens",
] as const;
const MODEL_KEYS = [
  GEN_AI.responseModel,
  GEN_AI.requestModel,
  "llm.model_name",
  "ai.model.id",
] as const;
const INT4_MAX = 2_147_483_647;
const MAX_ID = 256;

function tokenCount(span: DecodedSpan, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = attrNumber(span.attributes, key);
    if (value !== undefined && Number.isFinite(value) && value >= 0 && value <= INT4_MAX) {
      return Math.trunc(value);
    }
  }
  return null;
}

function modelOf(span: DecodedSpan): string | null {
  for (const key of MODEL_KEYS) {
    const value = attrString(span.attributes, key)?.trim();
    if (value) return value.slice(0, MAX_ID);
  }
  return null;
}

/**
 * Model spans that wrap another model span of the same call: OpenInference's
 * OpenAI Agents `generation` around the OpenAI client's `ChatCompletion` when
 * both instrumentations run. Only the innermost one is the round trip (it is
 * the one that carries the tool menu); counting both doubles calls and tokens.
 */
function wrappingModelSpans(
  models: readonly DecodedSpan[],
  byId: ReadonlyMap<string, DecodedSpan>,
): Set<string> {
  const ids = new Set(models.map((span) => span.spanId));
  const outer = new Set<string>();
  for (const span of models) {
    for (const ancestor of ancestorsOf(span, byId))
      if (ids.has(ancestor.spanId)) outer.add(ancestor.spanId);
  }
  return outer;
}

/** The first non-null reading of the span, else of its nearest ancestor that has one. */
function nearest<T>(
  span: DecodedSpan,
  byId: ReadonlyMap<string, DecodedSpan>,
  read: (s: DecodedSpan) => T | null,
): T | null {
  const own = read(span);
  if (own !== null) return own;
  for (const ancestor of ancestorsOf(span, byId)) {
    const found = read(ancestor);
    if (found !== null) return found;
  }
  return null;
}

/** Every model round trip in the export as an `otlp_model_call` row. */
export function deriveModelCalls(spans: readonly DecodedSpan[]): ParsedTraceEvent[] {
  const byId = indexSpans(spans);
  const models = spans.filter((span) => span.spanId && span.traceId && isModelRoundTrip(span));
  const wrappers = wrappingModelSpans(models, byId);
  const out: ParsedTraceEvent[] = [];
  for (const span of models) {
    if (wrappers.has(span.spanId)) continue;
    const session = resolveUp(span, byId, SESSION_KEYS);
    const startOk = plausibleOccurredAt(span.startUnixMs);
    const tookMs = startOk ? Math.max(0, Math.round(span.endUnixMs - span.startUnixMs)) : null;
    // Some frameworks (Mastra) put the menu and the messages on the agent or
    // step span around the model call rather than on the call itself.
    const menu = nearest(span, byId, toolMenuOf);
    const model = modelOf(span);
    const prompt = nearest(span, byId, (s) => promptOf(s.attributes));
    const agent = resolveUp(span, byId, AGENT_KEYS)?.slice(0, MAX_ID);
    out.push({
      ingestSource: "otlp",
      clientEventId: `otlp:model:${span.traceId}:${span.spanId}`,
      eventId: null,
      sourceId: attrString(span.resourceAttributes, "service.name")?.slice(0, MAX_ID) ?? null,
      invocationId: null,
      // OTLP spans carry no host turn id; the runtime lane does.
      turnId: null,
      traceId: span.traceId,
      spanId: span.spanId,
      type: OTLP_MODEL_CALL,
      schemaVersion: 1,
      sessionId: (session ?? span.traceId).slice(0, MAX_ID),
      occurredAt: startOk ?? new Date(),
      toolId: null,
      skillId: null,
      query: null,
      origin: null,
      tookMs: tookMs !== null && tookMs <= INT4_MAX ? tookMs : null,
      errorMessage:
        span.statusCode === 2 ? (attrString(span.attributes, "error.type") ?? "error") : null,
      topK: null,
      hitCount: null,
      server: null,
      searchId: null,
      correlationId: null,
      catalogVersion: null,
      harness: null,
      environment: null,
      endUserId: resolveUp(span, byId, USER_KEYS)?.slice(0, MAX_ID) ?? null,
      inputTokens: tokenCount(span, INPUT_TOKEN_KEYS),
      outputTokens: tokenCount(span, OUTPUT_TOKEN_KEYS),
      costUsd: null,
      payload: {
        type: OTLP_MODEL_CALL,
        derived_from: "otlp",
        ...(model ? { model } : {}),
        ...(menu ? { menu } : {}),
        ...(prompt ? { prompt } : {}),
        ...(prompt && isSystemPrompt(prompt) ? { started_by: "system" } : {}),
        ...(agent ? { agent } : {}),
      },
      hits: [],
    });
  }
  return out;
}
