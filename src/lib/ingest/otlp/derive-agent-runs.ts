import type { ParsedTraceEvent } from "@/lib/ingest/trace-events/parse";
import { AGENT_RUN_EVENT_TYPE } from "@/lib/ingest/trace-events/turns-schedule";
import { attrString } from "./anyvalue";
import {
  AGENT_KEYS,
  firstString,
  indexSpans,
  resolveUp,
  SESSION_KEYS,
  USER_KEYS,
} from "./attr-resolve";
import { GEN_AI } from "./constants";
import { promptOf } from "./prompt-text";
import { plausibleOccurredAt } from "./reconstruct";
import type { DecodedSpan } from "./types";

/** Root agent runs with their captured ask. Typed steps also accept workflow
 * roots. Nested agents become handoff rows in derive-steps. */

export { AGENT_RUN_EVENT_TYPE };

const MAX_ID = 256;
const INT4_MAX = 2_147_483_647;
const STATUS_ERROR = 2;

/** Every `invoke_agent` root span of the export as an `agent_run` row. */
export function deriveAgentRuns(
  spans: readonly DecodedSpan[],
  options: { typedSteps?: boolean } = {},
): ParsedTraceEvent[] {
  const byId = indexSpans(spans);
  return spans
    .filter((span) => isAgentRunRoot(span, options.typedSteps))
    .map((span) => agentRunRow(span, byId));
}

function isAgentRunRoot(span: DecodedSpan, typedSteps = false): boolean {
  return (
    !span.parentSpanId &&
    Boolean(span.spanId && span.traceId) &&
    ["invoke_agent", ...(typedSteps ? ["invoke_workflow"] : [])].includes(
      attrString(span.attributes, GEN_AI.operationName) ?? "",
    )
  );
}

function agentRunRow(span: DecodedSpan, byId: ReadonlyMap<string, DecodedSpan>): ParsedTraceEvent {
  const startOk = plausibleOccurredAt(span.startUnixMs);
  const tookMs = startOk ? Math.max(0, Math.round(span.endUnixMs - span.startUnixMs)) : null;
  const errorType = runErrorType(span);
  const ask = promptOf(span.attributes);
  const agent = firstString(span.attributes, AGENT_KEYS)?.slice(0, MAX_ID);
  return {
    ingestSource: "otlp",
    clientEventId: `otlp:agent:${span.traceId}:${span.spanId}`,
    eventId: null,
    sourceId: attrString(span.resourceAttributes, "service.name")?.slice(0, MAX_ID) ?? null,
    invocationId: null,
    turnId: null,
    traceId: span.traceId,
    spanId: span.spanId,
    type: AGENT_RUN_EVENT_TYPE,
    schemaVersion: 1,
    sessionId: (resolveUp(span, byId, SESSION_KEYS) ?? span.traceId).slice(0, MAX_ID),
    occurredAt: startOk ?? new Date(),
    toolId: null,
    skillId: null,
    query: null,
    origin: null,
    tookMs: tookMs !== null && tookMs <= INT4_MAX ? tookMs : null,
    errorMessage: errorType,
    topK: null,
    hitCount: null,
    server: null,
    searchId: null,
    correlationId: null,
    catalogVersion: null,
    harness: null,
    environment: null,
    endUserId: resolveUp(span, byId, USER_KEYS)?.slice(0, MAX_ID) ?? null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    payload: {
      type: AGENT_RUN_EVENT_TYPE,
      derived_from: "otlp",
      ...(agent ? { agent } : {}),
      ...(ask ? { prompt: ask } : {}),
      ...(errorType ? { error_type: errorType } : {}),
      ...(tookMs !== null ? { took_ms: tookMs } : {}),
    },
    hits: [],
  };
}

function runErrorType(span: DecodedSpan): string | null {
  const named = attrString(span.attributes, "error.type")?.trim();
  if (named) return named.slice(0, MAX_ID);
  return span.statusCode === STATUS_ERROR ? "error" : null;
}
