/**
 * `@ratel-ai/telemetry` — the `ratel.*` telemetry vocabulary.
 *
 * See the wire contract in `../CONVENTIONS.md`. Emitting the vocabulary is done
 * through the standard OpenTelemetry JS SDK; this package adds no transport and
 * no schema (ADR-0007). These constants are the `ratel.*` overlay Ratel owns,
 * plus the small subset of `gen_ai.*` keys the overlay emits directly on the
 * `execute_tool` span (borrowed verbatim from OpenTelemetry, never renamed).
 *
 * This package is OTel-free (ADR-0007): the OTLP config resolver and the
 * content-capture gate are re-exported from `./config`; the `init()` exporter,
 * which does pull the OpenTelemetry SDK, lives in `@ratel-ai/telemetry-otlp`.
 */

export {
  API_KEY_ENV,
  ContentCapture,
  clearContentCapture,
  contentCaptureMode,
  DEFAULT_SERVICE_NAME,
  type InitOptions,
  OTLP_ENDPOINT_ENV,
  type ResolvedOtlpConfig,
  resolveOtlpConfig,
  setContentCapture,
} from "./config.js";

/**
 * The pinned OpenTelemetry semantic-conventions version this vocabulary tracks
 * (the `gen_ai` group). The pin is the contract; consumers read against this
 * exact version, never "latest" (CONVENTIONS.md § The pin).
 */
export const SEMCONV_VERSION = "1.42.0";

/**
 * The ecosystem instrumentation env var gating message/tool content capture.
 * Default off; honored by `init()` rather than a Ratel-invented flag
 * (CONVENTIONS.md § Capture gating). Values: legacy boolean, or the enum
 * `NO_CONTENT` (default) / `SPAN_ONLY` / `EVENT_ONLY` / `SPAN_AND_EVENT`.
 */
export const CAPTURE_CONTENT_ENV = "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT";

// ---------------------------------------------------------------------------
// Span names (CONVENTIONS.md, Tier 2)
// ---------------------------------------------------------------------------

/** `ratel.search` — capability search (unifies tool-search and skill-search). */
export const RATEL_SEARCH = "ratel.search";

/**
 * `execute_tool` — the `gen_ai.operation.name` value for a tool invocation.
 *
 * Deliberately the standard OTel `gen_ai` operation, not a bespoke `ratel.invoke`
 * span, so a generic OTel backend already understands it (locked 2026-07-05). The
 * invoke is enriched with `ratel.*` attributes.
 */
export const EXECUTE_TOOL = "execute_tool";

/** `ratel.skill.load` — skill content load (`get_skill_content`). */
export const RATEL_SKILL_LOAD = "ratel.skill.load";

/** `ratel.upstream.register` — upstream-MCP ingest. */
export const RATEL_UPSTREAM_REGISTER = "ratel.upstream.register";

/** `ratel.auth.flow` — MCP auth flow. */
export const RATEL_AUTH_FLOW = "ratel.auth.flow";

// ---------------------------------------------------------------------------
// Span event names (CONVENTIONS.md)
// ---------------------------------------------------------------------------

/**
 * `ratel.search.results` — Opt-In event carrying hit ids + scores + per-stage
 * BM25 timing; gated like content. The `ratel.search` span itself carries only counts.
 */
export const RATEL_SEARCH_RESULTS = "ratel.search.results";

/**
 * `gen_ai.client.inference.operation.details` — the event that carries message
 * text and tool-call content (never span attributes). Borrowed from gen_ai (Tier 1).
 */
export const GEN_AI_INFERENCE_DETAILS = "gen_ai.client.inference.operation.details";

// ---------------------------------------------------------------------------
// `ratel.*` attribute keys (CONVENTIONS.md, Tier 2)
// ---------------------------------------------------------------------------

/** `ratel.origin` — direct library call vs agent-synthesized (shared attribute). */
export const RATEL_ORIGIN = "ratel.origin";

/** `ratel.search.target` — `tool` or `skill` (see {@link SearchTarget}). */
export const RATEL_SEARCH_TARGET = "ratel.search.target";

/** `ratel.search.top_k` — requested result count. */
export const RATEL_SEARCH_TOP_K = "ratel.search.top_k";

/** `ratel.search.hit_count` — results returned. */
export const RATEL_SEARCH_HIT_COUNT = "ratel.search.hit_count";

/** `ratel.search.query` — the search text (content, gated like message content). */
export const RATEL_SEARCH_QUERY = "ratel.search.query";

/** `ratel.tool.args_size_bytes` — argument payload size on the `execute_tool` span. */
export const RATEL_TOOL_ARGS_SIZE_BYTES = "ratel.tool.args_size_bytes";

/** `ratel.upstream.server` — upstream MCP server backing a tool / auth flow. */
export const RATEL_UPSTREAM_SERVER = "ratel.upstream.server";

/** `ratel.upstream.transport` — `stdio` / `http` / `sse` / ... */
export const RATEL_UPSTREAM_TRANSPORT = "ratel.upstream.transport";

/** `ratel.upstream.tool_count` — tools ingested on register. */
export const RATEL_UPSTREAM_TOOL_COUNT = "ratel.upstream.tool_count";

/** `ratel.skill.id` — skill loaded on the `ratel.skill.load` span. */
export const RATEL_SKILL_ID = "ratel.skill.id";

/** `ratel.auth.outcome` — `ok` / `refreshed` / `needs_auth` / `failed` (see {@link AuthOutcome}). */
export const RATEL_AUTH_OUTCOME = "ratel.auth.outcome";

// ---------------------------------------------------------------------------
// `gen_ai.*` interop keys (CONVENTIONS.md, Tier 1 — borrowed verbatim)
//
// Only the subset the `ratel.*` overlay directly emits on the `execute_tool`
// span. These are OpenTelemetry's, not ours: exposed so callers avoid
// stringly-typing them, never renamed into `ratel.*`.
// ---------------------------------------------------------------------------

/** `gen_ai.operation.name` — set to {@link EXECUTE_TOOL} for a tool invocation. */
export const GEN_AI_OPERATION_NAME = "gen_ai.operation.name";

/** `gen_ai.tool.name` — the capability tool id. */
export const GEN_AI_TOOL_NAME = "gen_ai.tool.name";

/** `gen_ai.tool.call.id` — tool call id, when available. */
export const GEN_AI_TOOL_CALL_ID = "gen_ai.tool.call.id";

/** `gen_ai.tool.call.arguments` — tool arguments (Opt-In content, gated). */
export const GEN_AI_TOOL_CALL_ARGUMENTS = "gen_ai.tool.call.arguments";

/** `gen_ai.tool.call.result` — tool result (Opt-In content, gated). */
export const GEN_AI_TOOL_CALL_RESULT = "gen_ai.tool.call.result";

// ---------------------------------------------------------------------------
// Enum wire values (CONVENTIONS.md, Tier 2)
//
// Modelled as `as const` value maps: the key is the ergonomic name, the value
// is the exact wire string carried by the corresponding attribute. Each has a
// companion type so callers get the closed union.
// ---------------------------------------------------------------------------

/**
 * Whether a `ratel.*` span was a direct library call or synthesized by the agent
 * inside its loop. Carried by `ratel.origin`; mirrors the local trace `Origin`
 * (ADR-0007).
 */
export const Origin = {
  Direct: "direct",
  Agent: "agent",
} as const;
export type Origin = (typeof Origin)[keyof typeof Origin];

/**
 * What a `ratel.search` span was searching. Carried by `ratel.search.target`;
 * folds capability-tool search and skill search into one span shape.
 */
export const SearchTarget = {
  Tool: "tool",
  Skill: "skill",
} as const;
export type SearchTarget = (typeof SearchTarget)[keyof typeof SearchTarget];

/**
 * Outcome of an MCP auth flow. Carried by `ratel.auth.outcome`; `NeedsAuth` is
 * the 401-driven `AuthNeeds` case (ADR-0007 `auth_needs`).
 */
export const AuthOutcome = {
  Ok: "ok",
  Refreshed: "refreshed",
  NeedsAuth: "needs_auth",
  Failed: "failed",
} as const;
export type AuthOutcome = (typeof AuthOutcome)[keyof typeof AuthOutcome];
