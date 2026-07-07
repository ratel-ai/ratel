//! `ratel-ai-telemetry` — the `ratel.*` telemetry vocabulary.
//!
//! See `README.md` and the wire contract in `../CONVENTIONS.md` for design.

/// The pinned OpenTelemetry semantic-conventions version this vocabulary tracks
/// (the `gen_ai` group). The pin is the contract; consumers read against this
/// exact version, never "latest". Bumping it is a reviewed change with its own
/// PR and, if the shape changed, a superseding ADR (CONVENTIONS.md § The pin).
pub const SEMCONV_VERSION: &str = "1.42.0";

/// The ecosystem instrumentation env var gating message/tool content capture.
/// Default off; the standard OTel gen_ai gate rather than a Ratel-invented flag
/// (CONVENTIONS.md § Capture gating). This crate is constants-only — the TS/Python
/// `init()` helpers read it. Values: legacy boolean, or the enum `NO_CONTENT`
/// (default) / `SPAN_ONLY` / `EVENT_ONLY` / `SPAN_AND_EVENT`.
pub const CAPTURE_CONTENT_ENV: &str = "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT";

// ---------------------------------------------------------------------------
// Span names (CONVENTIONS.md, Tier 2)
// ---------------------------------------------------------------------------

/// `ratel.search` — capability search (unifies tool-search and skill-search).
pub const RATEL_SEARCH: &str = "ratel.search";
/// `execute_tool` — the `gen_ai.operation.name` value for a tool invocation.
///
/// Deliberately the standard OTel `gen_ai` operation, not a bespoke
/// `ratel.invoke` span, so a generic OTel backend already understands it
/// (locked 2026-07-05). The invoke is enriched with `ratel.*` attributes.
pub const EXECUTE_TOOL: &str = "execute_tool";
/// `ratel.skill.load` — skill content load (`get_skill_content`).
pub const RATEL_SKILL_LOAD: &str = "ratel.skill.load";
/// `ratel.upstream.register` — upstream-MCP ingest.
pub const RATEL_UPSTREAM_REGISTER: &str = "ratel.upstream.register";
/// `ratel.auth.flow` — MCP auth flow.
pub const RATEL_AUTH_FLOW: &str = "ratel.auth.flow";

// ---------------------------------------------------------------------------
// Span event names (CONVENTIONS.md)
// ---------------------------------------------------------------------------

/// `ratel.search.results` — Opt-In event carrying hit ids + scores + per-stage
/// BM25 timing; gated like content. The `ratel.search` span itself carries only counts.
pub const RATEL_SEARCH_RESULTS: &str = "ratel.search.results";
/// `gen_ai.client.inference.operation.details` — the event that carries message
/// text and tool-call content (never span attributes). Borrowed from gen_ai (Tier 1).
pub const GEN_AI_INFERENCE_DETAILS: &str = "gen_ai.client.inference.operation.details";

// ---------------------------------------------------------------------------
// `ratel.*` attribute keys (CONVENTIONS.md, Tier 2)
// ---------------------------------------------------------------------------

/// `ratel.origin` — direct library call vs agent-synthesized (shared attribute).
pub const RATEL_ORIGIN: &str = "ratel.origin";
/// `ratel.search.target` — `tool` or `skill` (see [`SearchTarget`]).
pub const RATEL_SEARCH_TARGET: &str = "ratel.search.target";
/// `ratel.search.top_k` — requested result count.
pub const RATEL_SEARCH_TOP_K: &str = "ratel.search.top_k";
/// `ratel.search.hit_count` — results returned.
pub const RATEL_SEARCH_HIT_COUNT: &str = "ratel.search.hit_count";
/// `ratel.search.query` — the search text (content, gated like message content).
pub const RATEL_SEARCH_QUERY: &str = "ratel.search.query";
/// `ratel.tool.args_size_bytes` — argument payload size on the `execute_tool` span.
pub const RATEL_TOOL_ARGS_SIZE_BYTES: &str = "ratel.tool.args_size_bytes";
/// `ratel.upstream.server` — upstream MCP server backing a tool / auth flow.
pub const RATEL_UPSTREAM_SERVER: &str = "ratel.upstream.server";
/// `ratel.upstream.transport` — `stdio` / `http` / `sse` / ...
pub const RATEL_UPSTREAM_TRANSPORT: &str = "ratel.upstream.transport";
/// `ratel.upstream.tool_count` — tools ingested on register.
pub const RATEL_UPSTREAM_TOOL_COUNT: &str = "ratel.upstream.tool_count";
/// `ratel.skill.id` — skill loaded on the `ratel.skill.load` span.
pub const RATEL_SKILL_ID: &str = "ratel.skill.id";
/// `ratel.auth.outcome` — `ok` / `refreshed` / `needs_auth` / `failed` (see [`AuthOutcome`]).
pub const RATEL_AUTH_OUTCOME: &str = "ratel.auth.outcome";

// ---------------------------------------------------------------------------
// `gen_ai.*` interop keys (CONVENTIONS.md, Tier 1 — borrowed verbatim)
//
// Only the subset the `ratel.*` overlay directly emits on the `execute_tool`
// span. These are OpenTelemetry's, not ours: exposed so callers avoid
// stringly-typing them, never renamed into `ratel.*`.
// ---------------------------------------------------------------------------

/// `gen_ai.operation.name` — set to [`EXECUTE_TOOL`] for a tool invocation.
pub const GEN_AI_OPERATION_NAME: &str = "gen_ai.operation.name";
/// `gen_ai.tool.name` — the capability tool id.
pub const GEN_AI_TOOL_NAME: &str = "gen_ai.tool.name";
/// `gen_ai.tool.call.id` — tool call id, when available.
pub const GEN_AI_TOOL_CALL_ID: &str = "gen_ai.tool.call.id";
/// `gen_ai.tool.call.arguments` — tool arguments (Opt-In content, gated).
pub const GEN_AI_TOOL_CALL_ARGUMENTS: &str = "gen_ai.tool.call.arguments";
/// `gen_ai.tool.call.result` — tool result (Opt-In content, gated).
pub const GEN_AI_TOOL_CALL_RESULT: &str = "gen_ai.tool.call.result";

/// Whether a `ratel.*` span was a direct library call or synthesized by the
/// agent inside its loop. Emitted as the `ratel.origin` attribute; mirrors the
/// local trace `Origin` (ADR-0007).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    Direct,
    Agent,
}

impl Origin {
    /// The wire value carried by `ratel.origin`.
    pub fn as_str(self) -> &'static str {
        match self {
            Origin::Direct => "direct",
            Origin::Agent => "agent",
        }
    }
}

/// What a `ratel.search` span was searching. Emitted as `ratel.search.target`;
/// folds capability-tool search and skill search into one span shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchTarget {
    Tool,
    Skill,
}

impl SearchTarget {
    /// The wire value carried by `ratel.search.target`.
    pub fn as_str(self) -> &'static str {
        match self {
            SearchTarget::Tool => "tool",
            SearchTarget::Skill => "skill",
        }
    }
}

/// Outcome of an MCP auth flow. Emitted as `ratel.auth.outcome`; `needs_auth`
/// is the 401-driven `AuthNeeds` case (ADR-0007 `auth_needs`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthOutcome {
    Ok,
    Refreshed,
    NeedsAuth,
    Failed,
}

impl AuthOutcome {
    /// The wire value carried by `ratel.auth.outcome`.
    pub fn as_str(self) -> &'static str {
        match self {
            AuthOutcome::Ok => "ok",
            AuthOutcome::Refreshed => "refreshed",
            AuthOutcome::NeedsAuth => "needs_auth",
            AuthOutcome::Failed => "failed",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_maps_to_wire_strings() {
        assert_eq!(Origin::Direct.as_str(), "direct");
        assert_eq!(Origin::Agent.as_str(), "agent");
    }

    #[test]
    fn search_target_maps_to_wire_strings() {
        assert_eq!(SearchTarget::Tool.as_str(), "tool");
        assert_eq!(SearchTarget::Skill.as_str(), "skill");
    }

    #[test]
    fn auth_outcome_maps_to_wire_strings() {
        assert_eq!(AuthOutcome::Ok.as_str(), "ok");
        assert_eq!(AuthOutcome::Refreshed.as_str(), "refreshed");
        assert_eq!(AuthOutcome::NeedsAuth.as_str(), "needs_auth");
        assert_eq!(AuthOutcome::Failed.as_str(), "failed");
    }

    #[test]
    fn ratel_attribute_keys_match_the_pin() {
        assert_eq!(RATEL_ORIGIN, "ratel.origin");
        assert_eq!(RATEL_SEARCH_TARGET, "ratel.search.target");
        assert_eq!(RATEL_SEARCH_TOP_K, "ratel.search.top_k");
        assert_eq!(RATEL_SEARCH_HIT_COUNT, "ratel.search.hit_count");
        assert_eq!(RATEL_SEARCH_QUERY, "ratel.search.query");
        assert_eq!(RATEL_TOOL_ARGS_SIZE_BYTES, "ratel.tool.args_size_bytes");
        assert_eq!(RATEL_UPSTREAM_SERVER, "ratel.upstream.server");
        assert_eq!(RATEL_UPSTREAM_TRANSPORT, "ratel.upstream.transport");
        assert_eq!(RATEL_UPSTREAM_TOOL_COUNT, "ratel.upstream.tool_count");
        assert_eq!(RATEL_SKILL_ID, "ratel.skill.id");
        assert_eq!(RATEL_AUTH_OUTCOME, "ratel.auth.outcome");
    }

    #[test]
    fn semconv_pin_is_explicit() {
        // The pin IS the contract; consumers read against this exact version,
        // not "latest". Bumping it is a reviewed change (CONVENTIONS.md § The pin).
        assert_eq!(SEMCONV_VERSION, "1.42.0");
    }

    #[test]
    fn content_capture_gate_is_the_ecosystem_env_var() {
        assert_eq!(
            CAPTURE_CONTENT_ENV,
            "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"
        );
    }

    #[test]
    fn span_event_names_match_the_pin() {
        assert_eq!(RATEL_SEARCH_RESULTS, "ratel.search.results");
        assert_eq!(
            GEN_AI_INFERENCE_DETAILS,
            "gen_ai.client.inference.operation.details"
        );
    }

    #[test]
    fn span_names_match_the_pin() {
        assert_eq!(RATEL_SEARCH, "ratel.search");
        assert_eq!(RATEL_SKILL_LOAD, "ratel.skill.load");
        assert_eq!(RATEL_UPSTREAM_REGISTER, "ratel.upstream.register");
        assert_eq!(RATEL_AUTH_FLOW, "ratel.auth.flow");
    }

    #[test]
    fn tool_invocation_is_the_gen_ai_execute_tool_operation_not_ratel_invoke() {
        // Locked 2026-07-05: invoke rides an `execute_tool` gen_ai span for
        // OTel-backend interop, not a bespoke `ratel.invoke` span.
        assert_eq!(EXECUTE_TOOL, "execute_tool");
        assert_ne!(EXECUTE_TOOL, "ratel.invoke");
    }

    #[test]
    fn gen_ai_interop_keys_match_the_pin() {
        // Tier 1: borrowed verbatim from OTel gen_ai; the execute_tool overlay
        // rides these, so they must stay under gen_ai.* (interop), never ratel.*.
        assert_eq!(GEN_AI_OPERATION_NAME, "gen_ai.operation.name");
        assert_eq!(GEN_AI_TOOL_NAME, "gen_ai.tool.name");
        assert_eq!(GEN_AI_TOOL_CALL_ID, "gen_ai.tool.call.id");
        assert_eq!(GEN_AI_TOOL_CALL_ARGUMENTS, "gen_ai.tool.call.arguments");
        assert_eq!(GEN_AI_TOOL_CALL_RESULT, "gen_ai.tool.call.result");
        for key in [
            GEN_AI_OPERATION_NAME,
            GEN_AI_TOOL_NAME,
            GEN_AI_TOOL_CALL_ID,
            GEN_AI_TOOL_CALL_ARGUMENTS,
            GEN_AI_TOOL_CALL_RESULT,
        ] {
            assert!(key.starts_with("gen_ai."), "{key} is not under gen_ai.*");
            assert!(
                !key.starts_with("ratel."),
                "{key} must not be renamed into ratel.*"
            );
        }
    }

    #[test]
    fn every_ratel_attribute_key_is_namespaced() {
        for key in [
            RATEL_ORIGIN,
            RATEL_SEARCH_TARGET,
            RATEL_SEARCH_TOP_K,
            RATEL_SEARCH_HIT_COUNT,
            RATEL_SEARCH_QUERY,
            RATEL_TOOL_ARGS_SIZE_BYTES,
            RATEL_UPSTREAM_SERVER,
            RATEL_UPSTREAM_TRANSPORT,
            RATEL_UPSTREAM_TOOL_COUNT,
            RATEL_SKILL_ID,
            RATEL_AUTH_OUTCOME,
        ] {
            assert!(key.starts_with("ratel."), "{key} is not under ratel.*");
        }
    }

    #[test]
    fn attribute_keys_are_unique() {
        // A copy-paste dup (two concepts sharing a wire key) passes every
        // per-constant assert above; only a uniqueness check catches it.
        let keys = [
            RATEL_ORIGIN,
            RATEL_SEARCH_TARGET,
            RATEL_SEARCH_TOP_K,
            RATEL_SEARCH_HIT_COUNT,
            RATEL_SEARCH_QUERY,
            RATEL_TOOL_ARGS_SIZE_BYTES,
            RATEL_UPSTREAM_SERVER,
            RATEL_UPSTREAM_TRANSPORT,
            RATEL_UPSTREAM_TOOL_COUNT,
            RATEL_SKILL_ID,
            RATEL_AUTH_OUTCOME,
            GEN_AI_OPERATION_NAME,
            GEN_AI_TOOL_NAME,
            GEN_AI_TOOL_CALL_ID,
            GEN_AI_TOOL_CALL_ARGUMENTS,
            GEN_AI_TOOL_CALL_RESULT,
        ];
        let unique: std::collections::HashSet<&str> = keys.iter().copied().collect();
        assert_eq!(unique.len(), keys.len(), "duplicate attribute key");
    }

    #[test]
    fn span_names_are_unique() {
        // Same copy-paste risk as attribute_keys_are_unique, for the span names.
        let names = [
            RATEL_SEARCH,
            EXECUTE_TOOL,
            RATEL_SKILL_LOAD,
            RATEL_UPSTREAM_REGISTER,
            RATEL_AUTH_FLOW,
        ];
        let unique: std::collections::HashSet<&str> = names.iter().copied().collect();
        assert_eq!(unique.len(), names.len(), "duplicate span name");
    }

    #[test]
    fn event_names_are_unique() {
        // Same copy-paste risk for the two span-event names.
        let names = [RATEL_SEARCH_RESULTS, GEN_AI_INFERENCE_DETAILS];
        let unique: std::collections::HashSet<&str> = names.iter().copied().collect();
        assert_eq!(unique.len(), names.len(), "duplicate event name");
    }
}
