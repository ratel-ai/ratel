import type { ParsedTraceEvent } from "@/lib/ingest/trace-events/parse";
import { attrString } from "./anyvalue";
import {
  AGENT_KEYS,
  ancestorsOf,
  firstString,
  indexSpans,
  resolveUp,
  SESSION_KEYS,
  USER_KEYS,
} from "./attr-resolve";
import { plausibleOccurredAt } from "./reconstruct";
import { isModelRoundTrip, toolSpanDialect } from "./span-facts";
import type { DecodedSpan } from "./types";

export const OTLP_STEP = "otlp_step";
const MAX_ID = 256;
const INT4_MAX = 2_147_483_647;

/** Application work and nested agent transfers, without captured message content. */
export function deriveSteps(spans: readonly DecodedSpan[]): ParsedTraceEvent[] {
  const byId = indexSpans(spans);
  const rows: ParsedTraceEvent[] = [];
  for (const span of spans) {
    if (!span.traceId || !span.spanId) continue;
    const parent = ancestorsOf(span, byId).find(isAgent);
    const handoff = operation(span) === "invoke_agent" && Boolean(parent);
    if (!handoff && !isCode(span)) continue;
    const start = plausibleOccurredAt(span.startUnixMs);
    if (!start) continue;
    const duration = Math.max(0, Math.round(span.endUnixMs - span.startUnixMs));
    const kind = handoff ? "handoff" : "code";
    rows.push({
      ingestSource: "otlp",
      clientEventId: `otlp:step:${span.traceId}:${span.spanId}`,
      eventId: null,
      sourceId: attrString(span.resourceAttributes, "service.name")?.slice(0, MAX_ID) ?? null,
      invocationId: null,
      turnId: null,
      traceId: span.traceId,
      spanId: span.spanId,
      type: OTLP_STEP,
      schemaVersion: 1,
      sessionId: (resolveUp(span, byId, SESSION_KEYS) ?? span.traceId).slice(0, MAX_ID),
      occurredAt: start,
      toolId: null,
      skillId: null,
      query: null,
      origin: null,
      tookMs: Number.isFinite(duration) && duration <= INT4_MAX ? duration : null,
      errorMessage: span.statusCode === 2 ? "error" : null,
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
        type: OTLP_STEP,
        derived_from: "otlp",
        kind,
        name: (handoff
          ? agentName(span)
          : attrString(span.attributes, "ratel.step.name") || span.name
        ).slice(0, MAX_ID),
        parent_agent: parent ? agentName(parent) : null,
        status: span.statusCode === 2 ? "error" : "ok",
      },
      hits: [],
    });
  }
  return rows;
}

function isCode(span: DecodedSpan): boolean {
  if (isAgent(span) || isModelRoundTrip(span) || toolSpanDialect(span)) return false;
  if (
    span.kind !== 1 ||
    !Number.isFinite(span.endUnixMs - span.startUnixMs) ||
    span.endUnixMs - span.startUnixMs < 5
  )
    return false;
  if (/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)(?:\s|$)/i.test(span.name)) return false;
  if (
    /^ratel[.:/]/i.test(span.name) ||
    /(?:^|[/@.])ratel(?:-ai)?(?:[/@.]|$)/i.test(span.scopeName ?? "")
  )
    return false;
  return !Object.keys(span.attributes).some(
    (key) => key.startsWith("http.") || key.startsWith("db."),
  );
}

function operation(span: DecodedSpan): string | undefined {
  return attrString(span.attributes, "gen_ai.operation.name");
}

function isAgent(span: DecodedSpan): boolean {
  return operation(span) === "invoke_agent" || operation(span) === "invoke_workflow";
}

function agentName(span: DecodedSpan): string {
  return (
    firstString(span.attributes, AGENT_KEYS) ||
    span.name.replace(/^invoke_(?:agent|workflow)\s+/, "")
  ).slice(0, MAX_ID);
}
