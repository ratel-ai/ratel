import type { CloudEvent } from "@/lib/ingest/cloud-schema";
import { SEARCH_CAPABILITIES_ID, SEARCH_TOOLS_ID } from "@/lib/ingest/gateway-tools";
import { MAX_QUERY, type ParsedTraceEvent } from "@/lib/ingest/trace-events/parse";
import { attrNumber, attrString } from "./anyvalue";
import { RATEL, RATEL_SEARCH } from "./constants";
import { plausibleOccurredAt } from "./reconstruct";
import type { DecodedSpan } from "./types";

/** The gateway discovery tools whose calls carry a `search_capabilities` query. */
const SEARCH_CALL_NAMES = new Set<string>([SEARCH_CAPABILITIES_ID, SEARCH_TOOLS_ID]);

/**
 * Bridge the OTLP stream into the search ledger.
 *
 * The search views (top queries, match quality, Agent health) read `trace_events`,
 * but hosts send their telemetry as OTLP spans → `events`. The
 * `search_capabilities` queries the model asked are still captured: they ride in
 * the tool-call arguments of the reconstructed event (`lib/otlp/content.ts` keeps
 * `arguments` verbatim). This lifts those queries into synthetic `gateway_search`
 * trace events, so older OTel-only sources still reach those views. A source's
 * direct-facts era suppresses overlapping bridge rows at consolidation.
 *
 * Idempotent: `clientEventId` is derived from the event's dedupe hash + the call's
 * ordinal, so re-ingesting the same OTLP batch collides on the deterministic
 * trace-event id (`insertTraceEvents` does ON CONFLICT DO NOTHING) and never
 * double-counts. A call whose captured arguments carry no `query` string (content
 * capture off, or a non-search tool) is skipped — it still consumes its ordinal so
 * the numbering stays stable across re-ingestion.
 *
 * When both paths carry `ratel.event.id`, direct facts replace the OTLP projection
 * regardless of arrival order.
 */
export function deriveGatewaySearches(
  event: CloudEvent,
  opts: {
    dedupeHash: string;
    occurredAt: Date;
    endUserId: string | null;
    sourceId?: string | null;
  },
): ParsedTraceEvent[] {
  const out: ParsedTraceEvent[] = [];
  let ordinal = 0;
  for (const m of event.messages) {
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type !== "tool_call" || !SEARCH_CALL_NAMES.has(b.name)) continue;
      const i = ordinal++;
      const raw = b.arguments?.query;
      // Truncate to the wire schema's bound — these rows bypass the zod validation
      // the push endpoint applied, but should keep its size contract.
      const query = typeof raw === "string" ? raw.trim().slice(0, MAX_QUERY) : "";
      if (!query) continue; // no captured query text → nothing to derive
      out.push({
        ingestSource: "otlp",
        clientEventId: `otlp:${opts.dedupeHash}:gwsearch:${i}`,
        eventId: null,
        sourceId: opts.sourceId ?? null,
        invocationId: null,
        traceId: null,
        spanId: null,
        turnId: null,
        type: "gateway_search",
        schemaVersion: 1,
        // trace_events.session_id is nullable, but ParsedTraceEvent types it as a
        // string; the per-event dedupe hash is a stable, non-empty stand-in (OTLP
        // events carry no session id of their own).
        sessionId: opts.dedupeHash,
        occurredAt: opts.occurredAt,
        toolId: null,
        skillId: null,
        query,
        origin: "agent",
        tookMs: null,
        errorMessage: null,
        topK: null,
        hitCount: null,
        server: null,
        searchId: null,
        correlationId: null,
        catalogVersion: null,
        harness: null,
        environment: null,
        endUserId: opts.endUserId,
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        payload: { type: "gateway_search", query, origin: "agent", derived_from: "otlp" },
        hits: [],
      });
    }
  }
  return out;
}

/** `ratel.search.target` → the ledger's native event type for that search. */
const TARGET_TYPES: Record<string, "search" | "skill_search"> = {
  tool: "search",
  skill: "skill_search",
};

/**
 * Marker rows for `ratel.search` spans that arrived WITHOUT a query (the SDK's
 * capture gate is off). Deliberately NOT one of the ledger's search types, so
 * search analytics never see it. It persists the fact that an SDK host is
 * searching but not capturing (such batches otherwise leave no DB footprint at
 * all); nothing reads it since the Intents tab's empty-state triage was removed.
 */
export const SEARCH_UNCAPTURED_TYPE = "search_uncaptured";

const INT4_MAX = 2_147_483_647;

/** A non-negative int4-safe integer, or null — these rows bypass the wire zod
 * bounds, and one out-of-range value would abort the whole batch insert. */
function intCol(v: number | undefined): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  const n = Math.trunc(v);
  return n >= 0 && n <= INT4_MAX ? n : null;
}

/**
 * Derive search-ledger rows from the SDK funnel's `ratel.search` spans.
 *
 * These spans arrive anchor-less: the SDK's OTel funnel traces its own catalog
 * operations, usually on a different tracer provider (and thus different traces)
 * than the host's LLM instrumentation, so `groupSpans` never attaches them to a
 * call and they were previously dropped on the floor. When the emitter's capture
 * gate is in a span mode, the span carries `ratel.search.query` — enough to make
 * a native `search`/`skill_search` ledger row (counts only; hit ids ride the
 * opt-in `ratel.search.results` event, which the SDK doesn't emit yet). A span
 * WITHOUT a query becomes a {@link SEARCH_UNCAPTURED_TYPE} marker row instead,
 * so "SDK searching with capture off" stays distinguishable from "no telemetry":
 * such batches persist nothing else.
 *
 * Direct runtime facts are authoritative once a source begins publishing them;
 * the ingest consolidator suppresses this derived row at that source boundary.
 *
 * Idempotent: the client-event id is derived from the span's own ids, which
 * BatchSpanProcessor retries reuse, so re-exports collide on the deterministic
 * trace-event id and never double-count.
 */
export function deriveRatelSearches(spans: DecodedSpan[]): ParsedTraceEvent[] {
  const out: ParsedTraceEvent[] = [];
  for (const s of spans) {
    // An id-less span (the decoder tolerates them) would collapse every such
    // search onto one deterministic id, silently dropping all but the first.
    if (s.name !== RATEL_SEARCH || !s.spanId) continue;
    const query = attrString(s.attributes, RATEL.searchQuery)?.trim().slice(0, MAX_QUERY) ?? "";
    const target = attrString(s.attributes, RATEL.searchTarget) ?? "";
    const origin = attrString(s.attributes, RATEL.origin) ?? null;
    const topK = intCol(attrNumber(s.attributes, RATEL.searchTopK));
    const hitCount = intCol(attrNumber(s.attributes, RATEL.searchHitCount));
    // A broken start clock makes the duration as meaningless as the timestamp.
    const startOk = plausibleOccurredAt(s.startUnixMs);
    const tookMs = startOk ? intCol(Math.round(s.endUnixMs - s.startUnixMs)) : null;
    const type = query ? (TARGET_TYPES[target] ?? "search") : SEARCH_UNCAPTURED_TYPE;
    const eventId = attrString(s.attributes, RATEL.eventId) ?? null;
    out.push({
      ingestSource: "otlp",
      clientEventId: eventId ?? `otlp:span:${s.traceId}:${s.spanId}`,
      eventId,
      sourceId: attrString(s.resourceAttributes, "service.name") ?? null,
      invocationId: null,
      traceId: s.traceId,
      spanId: s.spanId,
      turnId: null,
      type,
      schemaVersion: 1,
      // Spans carry no session id; the trace id is a stable, non-empty stand-in.
      sessionId: s.traceId,
      occurredAt: startOk ?? new Date(),
      toolId: null,
      skillId: null,
      query: query || null,
      origin,
      tookMs,
      errorMessage: null,
      topK,
      hitCount,
      server: null,
      searchId: null,
      correlationId: null,
      catalogVersion: null,
      harness: null,
      environment: null,
      endUserId: null,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      payload: {
        type,
        ...(query ? { query } : { reason: "content_capture_off" }),
        ...(target ? { target } : {}),
        ...(origin ? { origin } : {}),
        ...(topK != null ? { top_k: topK } : {}),
        ...(hitCount != null ? { hit_count: hitCount } : {}),
        ...(tookMs != null ? { took_ms: tookMs } : {}),
        derived_from: "otlp",
      },
      hits: [],
    });
  }
  return out;
}
