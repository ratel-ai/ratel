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

/**
 * One `agent_run` ledger row per `invoke_agent` root span (RC-742), so a run
 * that calls no tool still makes a turn. Ratel's own backend jobs export
 * this shape (`lib/observability/agent-run.ts`): one `invoke_agent <job kind>`
 * root with the job's ask, and its `chat` model calls as children. Only tool
 * and search rows made turns before, so these runs made none.
 *
 * Only a root span counts: a nested `invoke_agent` (a sub-agent) is part of
 * its parent's run. The row is the root alone: the root ends last, so its
 * children often arrive in an earlier export, and the turn is keyed by the
 * trace either way. A bare `chat` span with no `invoke_agent` root makes no
 * row and no turn.
 *
 * The row carries the run's ask (`prompt`, the root's last user message) and
 * the agent's name; the turn's ask is read from it (`label-queries.ts`).
 * Idempotent: the client-event id is the span's own ids.
 */

export { AGENT_RUN_EVENT_TYPE };

const MAX_ID = 256;
const INT4_MAX = 2_147_483_647;
const STATUS_ERROR = 2;

/** Every `invoke_agent` root span of the export as an `agent_run` row. */
export function deriveAgentRuns(spans: readonly DecodedSpan[]): ParsedTraceEvent[] {
  const byId = indexSpans(spans);
  return spans.filter(isAgentRunRoot).map((span) => agentRunRow(span, byId));
}

function isAgentRunRoot(span: DecodedSpan): boolean {
  return (
    !span.parentSpanId &&
    Boolean(span.spanId && span.traceId) &&
    attrString(span.attributes, GEN_AI.operationName) === "invoke_agent"
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
