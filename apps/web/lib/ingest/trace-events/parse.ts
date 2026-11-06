import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * The trace-events ledger's event shapes: `ParsedTraceEvent`/`ParsedHit` and the
 * `deterministicEventId` idempotency key are what `insertTraceEvents` and the
 * OTLP bridge (`lib/otlp/derive-search.ts`) are built on. No database here —
 * callers inject the persistence step, and these functions are unit-tested
 * standalone.
 *
 * The wire validation half (`parseTraceEvents` + the per-type zod schemas) is
 * the contract of `POST /api/v1/events`; seed scripts and pipeline integration
 * tests use the same parser to fabricate ledger rows in the native shapes.
 *
 * Wire shape: the SDK flattens its `TraceEvent` union into its `TraceEnvelope`,
 * so each item is one flat object — `{ v, ts, session_id, type, ...eventFields }`
 * (see `ratel` core `trace/event.rs`). We validate per item (a malformed event
 * never sinks the batch), promote the fields the hot queries need into typed
 * columns, and keep the whole raw object as `payload` so nothing is ever lost.
 *
 * Forward-compat is deliberate: a *known* type that fails its schema is rejected,
 * but an *unrecognized* type still stores (envelope-only) via the loose fallback —
 * so a newer SDK emitting a new event kind needs no synchronized Cloud deploy.
 */

/* — Bounds ———————————————————————————————————————————————————————————————————

   The coarse events/chats routes cap per-message size; this higher-frequency
   stream needs the same so one authenticated request can't write unbounded rows
   or bytes (child-table amplification via `hits`, or a giant `payload`). Caps are
   generous — real SDK events sit well under them — so they reject abuse, not data. */

/** Max serialized bytes for a single event (its whole raw object). */
export const MAX_EVENT_BYTES = 64 * 1024;
/** Max hits in one search event → bounds the trace_event_hits fan-out per event. */
export const MAX_HITS = 512;
const MAX_ID = 512; // tool/skill/server/session ids and short scalar fields
// The SDK exporter derives `client_event_id` as `${session_id}:${suffix}` where
// the suffix is the u64 `seq` (≤ 20 chars) or a UUID fallback (36 chars), so its
// bound must admit a max-length session_id plus the longest suffix — otherwise a
// valid ≤512-char session_id would get every one of its events rejected.
const MAX_CLIENT_EVENT_ID = MAX_ID + 1 + 36;
/** Max search-query text. Exported so the OTLP derivations (which build
 * `ParsedTraceEvent`s directly, bypassing the zod wire schemas) keep the same bound. */
export const MAX_QUERY = 4 * 1024;
const MAX_ERROR = 16 * 1024;

/** JS Date's representable range is ±8.64e15 ms; beyond it `new Date()` is Invalid. */
const MAX_EPOCH_MS = 8_640_000_000_000_000;

/* Destination-column domains. Every promoted numeric is bounded here so an
   out-of-range value rejects that one item instead of overflowing the typed
   column at insert — where it would roll back the whole batch's transaction
   and break the per-item partial-success contract. */
/** PostgreSQL `integer` (int4) upper bound — the promoted count/duration columns. */
const MAX_INT4 = 2_147_483_647;
/** `cost_usd` is `numeric(12, 6)`: six integer digits, so values must stay < 10^6. */
const MAX_COST_USD = 1_000_000;

/** Normalize an epoch `ts` to milliseconds (tolerating a seconds-scale value). */
export function epochMs(ts: number): number {
  return ts < 1e12 ? ts * 1000 : ts;
}

/** True when `ts` maps to a Date JS/Postgres can actually represent. Guards the
 * shared parent insert from an Invalid Date (which would throw and sink the batch). */
function isRepresentableEpoch(ts: number): boolean {
  return Number.isFinite(ts) && ts >= 0 && epochMs(ts) <= MAX_EPOCH_MS;
}

/* — Envelope + optional additive fields (accepted on every event) ———————————— */

// The v1 envelope invariants plus forward-compat metric fields the SDK doesn't
// emit yet (see docs/trace-events-metrics-superset.md). Declaring them here means
// they survive validation into the promoted columns the moment the SDK sends them.
const envelopeShape = {
  v: z.number().int().min(0).max(MAX_INT4),
  // epoch milliseconds (SDK `now_ms()`); bounded so an out-of-range value (e.g. a
  // nanosecond timestamp) is rejected as one item rather than crashing the insert.
  ts: z.number().refine(isRepresentableEpoch, "ts is outside the representable epoch range"),
  session_id: z.string().min(1).max(MAX_ID),
  // Envelope v2: stable event/source identity plus optional invocation and OTel
  // correlation. v2 requires event_id + source_id; v1 remains accepted below.
  event_id: z.string().min(1).max(MAX_ID).optional(),
  source_id: z.string().min(1).max(MAX_ID).optional(),
  invocation_id: z.string().min(1).max(MAX_ID).optional(),
  trace_id: z.string().min(1).max(64).optional(),
  span_id: z.string().min(1).max(32).optional(),
  // Correlates one agent turn's search with the invoke(s) that confirm it
  // (ADR-0014 pairing; host-supplied, never minted by the SDK). Promoted so the
  // intent-graph fold can pair by (session_id, turn_id) without a jsonb scan.
  // Lenient: it rides on events every shipped SDK already sends, so a bad
  // value costs the pairing, never the event.
  turn_id: lenient(z.string().min(1).max(MAX_ID)),
  // Idempotency key; when absent we fall back to a content hash of the raw event.
  client_event_id: z.string().min(1).max(MAX_CLIENT_EVENT_ID).optional(),
  // Explicit event-time override (ISO). The wire uses `ts`; the seed script and
  // tests use this to spread synthetic events across a time window.
  occurred_at: z.coerce.date().optional(),
  // Forward-compat placeholders — promoted to columns, additive, all optional.
  search_id: z.string().max(MAX_ID).optional(),
  correlation_id: z.string().max(MAX_ID).optional(),
  catalog_version: z.string().max(MAX_ID).optional(),
  harness: z.string().max(MAX_ID).optional(),
  environment: z.string().max(MAX_ID).optional(),
  // Opaque id of the customer's END-user the agent served (not a dashboard user).
  end_user_id: z.string().max(MAX_ID).optional(),
  input_tokens: z.number().int().min(0).max(MAX_INT4).optional(),
  output_tokens: z.number().int().min(0).max(MAX_INT4).optional(),
  cost_usd: z.number().min(0).lt(MAX_COST_USD).optional(),
} as const;

/**
 * A field added to an event type that shipped SDKs already send. An invalid
 * value is treated as absent rather than failing the event, which is what
 * main did when it did not know the field: the event's own data is kept and
 * only the addition is lost. `toParsed` also strips it from the stored
 * payload so a reader's payload fallback cannot see the rejected value.
 * New standalone event types stay strict: only the co-developed SDK sends
 * them, and a reject with a reason is the useful signal there.
 */
const LENIENT_KEYS = ["turn_id", "base_hits"] as const;
function lenient<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (value) => (schema.safeParse(value).success ? value : undefined),
    schema.optional(),
  );
}

// took_ms fits the int4 column; fractional values are rounded in `toParsed`.
const nonNegNum = z.number().min(0).max(MAX_INT4);
const id = z.string().max(MAX_ID);
const toolHit = z.object({ tool_id: id, score: z.number().optional() });
const skillHit = z.object({ skill_id: id, score: z.number().optional() });
const query = z.string().max(MAX_QUERY);
const errorMsg = z.string().max(MAX_ERROR);

// origin is stored verbatim as text (not an enum) so a new origin value never
// rejects an otherwise-valid event.
const origin = z.string().max(MAX_ID).optional();

/**
 * Per-type schemas, keyed by the verbatim wire tag. Each declares the envelope
 * plus the fields that identify the event and that we promote to columns; any
 * other field the SDK sends (churn `kind`, search `stages`, `args_size_bytes`,
 * `transport`, `tool_count`, `ok`, …) is still accepted and preserved in
 * `payload` — objects default to stripping unknown keys, never rejecting them.
 */
const KNOWN_SCHEMAS = {
  search: z.object({
    ...envelopeShape,
    type: z.literal("search"),
    query,
    origin,
    top_k: z.number().int().min(0).max(MAX_INT4).optional(),
    hits: z.array(toolHit).max(MAX_HITS).optional(),
    // The ranking the runtime would have served without its intent graph, sent
    // only when the graph changed the result (ADR-0014). Payload-only: it is
    // the "without" side of Cloud's comparison, never a served hit.
    base_hits: lenient(z.array(toolHit).max(MAX_HITS)),
    took_ms: nonNegNum.optional(),
  }),
  skill_search: z.object({
    ...envelopeShape,
    type: z.literal("skill_search"),
    query,
    origin,
    top_k: z.number().int().min(0).max(MAX_INT4).optional(),
    hits: z.array(skillHit).max(MAX_HITS).optional(),
    base_hits: lenient(z.array(skillHit).max(MAX_HITS)),
    took_ms: nonNegNum.optional(),
  }),
  gateway_search: z.object({
    ...envelopeShape,
    type: z.literal("gateway_search"),
    query,
    origin,
    top_k: z.number().int().min(0).max(MAX_INT4).optional(),
    // NOTE: gateway_search.hits is a bare count (u32), not a hits array — so these
    // searches record `hit_count` but cannot populate trace_event_hits (SDK gap).
    hits: z.number().int().min(0).max(MAX_INT4).optional(),
    took_ms: nonNegNum.optional(),
  }),
  // One request opening (a Ratel SDK turn scope). `user_message` is sent only when
  // the caller passes it; Agent health reads it as the run's ask.
  turn_start: z.object({
    ...envelopeShape,
    type: z.literal("turn_start"),
    turn_id: id,
    user_message: query.optional(),
  }),
  skill_invoke: z.object({
    ...envelopeShape,
    type: z.literal("skill_invoke"),
    skill_id: id,
    took_ms: nonNegNum.optional(),
  }),
  skill_churn: z.object({
    ...envelopeShape,
    type: z.literal("skill_churn"),
    skill_id: id,
  }),
  index_churn: z.object({
    ...envelopeShape,
    type: z.literal("index_churn"),
    tool_id: id,
  }),
  invoke_start: z.object({
    ...envelopeShape,
    type: z.literal("invoke_start"),
    tool_id: id,
  }),
  invoke_end: z.object({
    ...envelopeShape,
    type: z.literal("invoke_end"),
    tool_id: id,
    took_ms: nonNegNum.optional(),
  }),
  invoke_error: z.object({
    ...envelopeShape,
    type: z.literal("invoke_error"),
    tool_id: id,
    took_ms: nonNegNum.optional(),
    error: errorMsg,
  }),
  gateway_invoke: z.object({
    ...envelopeShape,
    type: z.literal("gateway_invoke"),
    tool_id: id,
    took_ms: nonNegNum.optional(),
  }),
  gateway_error: z.object({
    ...envelopeShape,
    type: z.literal("gateway_error"),
    tool_id: id,
    error: errorMsg,
  }),
  upstream_register: z.object({
    ...envelopeShape,
    type: z.literal("upstream_register"),
    server: id,
  }),
  upstream_invoke: z.object({
    ...envelopeShape,
    type: z.literal("upstream_invoke"),
    server: id,
    tool_id: id,
    took_ms: nonNegNum.optional(),
  }),
  upstream_error: z.object({
    ...envelopeShape,
    type: z.literal("upstream_error"),
    server: id,
    tool_id: id,
    error: errorMsg,
  }),
  auth_refresh: z.object({
    ...envelopeShape,
    type: z.literal("auth_refresh"),
    upstream: id,
  }),
  auth_needs: z.object({
    ...envelopeShape,
    type: z.literal("auth_needs"),
    upstream: id,
  }),
  auth_flow_start: z.object({
    ...envelopeShape,
    type: z.literal("auth_flow_start"),
    upstream: id,
  }),
  auth_flow_end: z.object({
    ...envelopeShape,
    type: z.literal("auth_flow_end"),
    upstream: id,
  }),
  // The runtime publisher's client-drop marker (queue overflow between flushes);
  // first-class per the runtime-events ADR type table. Fields stay payload-only
  // but are validated so the drop ledger is queryable.
  events_dropped: z.object({
    ...envelopeShape,
    type: z.literal("events_dropped"),
    dropped_count: z.number().int().min(0),
    reason: z.string().min(1).max(MAX_ID),
    window_start_ts: z
      .number()
      .refine(isRepresentableEpoch, "window_start_ts is outside the representable epoch range")
      .optional(),
    window_end_ts: z
      .number()
      .refine(isRepresentableEpoch, "window_end_ts is outside the representable epoch range")
      .optional(),
  }),
  // Adaptive-ranking diagnostics (ADR-0014, remotely publishable since the
  // 2026-09-24 ADR-0020 amendment). Fields stay payload-only: the dashboard
  // reads "any usage_boost per source lately" and the per-runtime status row
  // that `usage_ranking_status` maintains, not per-event columns. Validated so
  // a malformed one is rejected as one item instead of poisoning a read.
  usage_boost: z.object({
    ...envelopeShape,
    type: z.literal("usage_boost"),
    // Matched cluster id, or null on a miss. Never query text.
    intent: z.string().max(MAX_ID).nullable(),
    similarity: z.number(),
    support: z.number().int().min(0),
    promoted: z.number().int().min(0),
    dropped: z.number().int().min(0).default(0),
  }),
  usage_model_mismatch: z.object({
    ...envelopeShape,
    type: z.literal("usage_model_mismatch"),
    built: z.string().max(MAX_ID),
    active: z.string().max(MAX_ID),
    dim_mismatch: z.boolean(),
  }),
  usage_cluster_policy_changed: z.object({
    ...envelopeShape,
    type: z.literal("usage_cluster_policy_changed"),
    built_similarity: z.number(),
    built_coverage: z.number(),
    active_similarity: z.number(),
    active_coverage: z.number(),
  }),
  // status: active | inactive | unknown | paused; reason: enabled | disabled |
  // rebuilt. Bounded strings rather than enums so a value a newer SDK adds is
  // stored, not rejected; readers map anything unexpected to "unknown".
  usage_ranking_status: z.object({
    ...envelopeShape,
    type: z.literal("usage_ranking_status"),
    status: z.string().min(1).max(MAX_ID),
    reason: z.string().min(1).max(MAX_ID),
    rev: z.number().int().min(0).optional(),
    graph_key: z.string().max(MAX_ID).optional(),
    learn: z.boolean().default(true),
    model: z.string().max(MAX_ID).optional(),
  }),
} as const;

/** The event tags Cloud promotes to columns. Anything else stores payload-only. */
export const KNOWN_TRACE_EVENT_TYPES = Object.keys(KNOWN_SCHEMAS) as Array<
  keyof typeof KNOWN_SCHEMAS
>;

/** Envelope-only fallback for an unrecognized `type` (forward-compat). */
const looseSchema = z.object({ ...envelopeShape, type: z.string().min(1) });

/* — Output shape ———————————————————————————————————————————————————————————— */

export type ParsedHit = {
  rank: number;
  targetType: "tool" | "skill";
  targetId: string;
  score: number | null;
};

/**
 * A validated event flattened into the promoted columns + its hits + the raw
 * payload. `projectId` and the deterministic `id` are attached later by the DB
 * layer (they depend on the authenticated project).
 */
export type ParsedTraceEvent = {
  /** Persistence provenance, attached by ingest paths after wire parsing. */
  ingestSource?: "runtime" | "otlp";
  clientEventId: string;
  eventId: string | null;
  sourceId: string | null;
  invocationId: string | null;
  traceId: string | null;
  spanId: string | null;
  turnId: string | null;
  type: string;
  schemaVersion: number;
  sessionId: string;
  occurredAt: Date;
  toolId: string | null;
  skillId: string | null;
  query: string | null;
  origin: string | null;
  tookMs: number | null;
  errorMessage: string | null;
  topK: number | null;
  hitCount: number | null;
  server: string | null;
  searchId: string | null;
  correlationId: string | null;
  catalogVersion: string | null;
  harness: string | null;
  environment: string | null;
  endUserId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  payload: Record<string, unknown>;
  hits: ParsedHit[];
};

export type ParseResult = {
  valid: ParsedTraceEvent[];
  rejected: Array<{ index: number; error: string }>;
};

/* — Helpers ————————————————————————————————————————————————————————————————— */

/**
 * Epoch `ts` → Date. The SDK sends milliseconds (`now_ms()`); we tolerate a
 * seconds-scale value (anything below the year-2001 ms threshold) so a caller
 * that sends epoch-seconds still lands in the right era rather than at 1970.
 * `ts` is validated in-range upstream (isRepresentableEpoch), so the Date is
 * always valid here.
 */
export function epochToDate(ts: number): Date {
  return new Date(epochMs(ts));
}

/** Deterministic key-sorted JSON, so an identical event always hashes the same. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const body = keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(",");
  return `{${body}}`;
}

/** Content hash of the raw event — the idempotency key when the SDK sends no id. */
export function contentHash(raw: unknown): string {
  return createHash("sha256").update(stableStringify(raw)).digest("hex");
}

/**
 * A stable uuidv8 derived from (projectId, clientEventId). Two identical flushes
 * collide on this id, so `ON CONFLICT DO NOTHING` makes ingestion idempotent
 * without a round-trip to check existence first.
 */
export function deterministicEventId(projectId: string, clientEventId: string): string {
  const hex = createHash("sha256")
    .update(`${projectId}\u0000${clientEventId}`)
    .digest("hex")
    .slice(0, 32)
    .split("");
  hex[12] = "8"; // version 8 (custom, RFC-4122)
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16); // variant 10xx
  const s = hex.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

function fmtError(err: z.ZodError): string {
  return err.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** For integer columns fed by numeric wire fields (e.g. a fractional took_ms). */
const roundedNum = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.round(n);
};

/** Build the promoted columns + hits from validated data. `data` only carries the
 * declared keys, so absent fields naturally map to null. */
function toParsed(type: string, data: Record<string, unknown>, raw: unknown): ParsedTraceEvent {
  const hits: ParsedHit[] = [];
  let hitCount: number | null = null;

  if (type === "search" && Array.isArray(data.hits)) {
    (data.hits as Array<Record<string, unknown>>).forEach((h, rank) =>
      hits.push({ rank, targetType: "tool", targetId: String(h.tool_id), score: num(h.score) }),
    );
    hitCount = hits.length;
  } else if (type === "skill_search" && Array.isArray(data.hits)) {
    (data.hits as Array<Record<string, unknown>>).forEach((h, rank) =>
      hits.push({ rank, targetType: "skill", targetId: String(h.skill_id), score: num(h.score) }),
    );
    hitCount = hits.length;
  } else if (type === "gateway_search") {
    hitCount = num(data.hits); // bare count on the wire
  }

  return {
    clientEventId: str(data.event_id) ?? str(data.client_event_id) ?? contentHash(raw),
    eventId: str(data.event_id),
    sourceId: str(data.source_id),
    invocationId: str(data.invocation_id),
    traceId: str(data.trace_id),
    spanId: str(data.span_id),
    turnId: str(data.turn_id),
    type,
    schemaVersion: data.v as number,
    sessionId: data.session_id as string,
    occurredAt:
      data.occurred_at instanceof Date ? data.occurred_at : epochToDate(data.ts as number),
    toolId: str(data.tool_id),
    skillId: str(data.skill_id),
    query: str(data.query),
    origin: str(data.origin),
    tookMs: roundedNum(data.took_ms),
    errorMessage: str(data.error),
    topK: num(data.top_k),
    hitCount,
    server: str(data.server),
    searchId: str(data.search_id),
    correlationId: str(data.correlation_id),
    catalogVersion: str(data.catalog_version),
    harness: str(data.harness),
    environment: str(data.environment),
    // `|| null` (not ??) deliberately folds "" to NULL, so an empty wire value
    // means "no end user" rather than an end user whose id is the empty string.
    endUserId: str(data.end_user_id) || null,
    inputTokens: num(data.input_tokens),
    outputTokens: num(data.output_tokens),
    costUsd: num(data.cost_usd),
    payload: storedPayload(data, raw),
    hits,
  };
}

/** The raw event as stored, less any lenient field whose value was rejected. */
function storedPayload(data: Record<string, unknown>, raw: unknown): Record<string, unknown> {
  const payload = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const dropped = LENIENT_KEYS.filter((key) => key in payload && data[key] === undefined);
  if (dropped.length === 0) return payload;
  const copy = { ...payload };
  for (const key of dropped) delete copy[key];
  return copy;
}

function parseOne(
  raw: unknown,
): { ok: true; parsed: ParsedTraceEvent } | { ok: false; error: string } {
  // Reject an oversized event before anything else — bounds the stored payload
  // regardless of type (an unknown-type event skips the per-field caps below).
  if (Buffer.byteLength(JSON.stringify(raw ?? null), "utf8") > MAX_EVENT_BYTES) {
    return { ok: false, error: `event exceeds ${MAX_EVENT_BYTES} bytes` };
  }

  const type = raw && typeof raw === "object" ? (raw as { type?: unknown }).type : undefined;
  const version = raw && typeof raw === "object" ? (raw as { v?: unknown }).v : undefined;
  if (typeof version === "number" && version >= 2) {
    const eventId = (raw as { event_id?: unknown }).event_id;
    const sourceId = (raw as { source_id?: unknown }).source_id;
    if (typeof eventId !== "string" || eventId.length === 0) {
      return { ok: false, error: "event_id: required for envelope v2" };
    }
    if (typeof sourceId !== "string" || sourceId.length === 0) {
      return { ok: false, error: "source_id: required for envelope v2" };
    }
  }
  const known =
    typeof type === "string" ? KNOWN_SCHEMAS[type as keyof typeof KNOWN_SCHEMAS] : undefined;

  if (known) {
    const r = known.safeParse(raw);
    if (!r.success) return { ok: false, error: fmtError(r.error) };
    return { ok: true, parsed: toParsed(type as string, r.data as Record<string, unknown>, raw) };
  }

  // Unrecognized (or missing) type → envelope-only fallback, stored payload-only.
  const r = looseSchema.safeParse(raw);
  if (!r.success) return { ok: false, error: fmtError(r.error) };
  return { ok: true, parsed: toParsed(r.data.type, r.data as Record<string, unknown>, raw) };
}

/**
 * Validate a batch per item. Returns the events that parsed and, separately, the
 * index + reason for each that didn't — the route reports both so one bad event
 * never fails the flush.
 */
export function parseTraceEvents(rawList: unknown[]): ParseResult {
  const valid: ParsedTraceEvent[] = [];
  const rejected: Array<{ index: number; error: string }> = [];
  rawList.forEach((raw, index) => {
    const r = parseOne(raw);
    if (r.ok) valid.push(r.parsed);
    else rejected.push({ index, error: r.error });
  });
  return { valid, rejected };
}
