use serde::{Deserialize, Serialize};

/// Distinguishes a direct API call (pre-fetch helpers, library callers,
/// benchmarks) from one the agent synthesized inside its loop (gateway tool).
/// Used to separate the two paths in trace consumers (rerankers train on agent
/// calls, inspector shows both).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Origin {
    Direct,
    Agent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChurnKind {
    Add,
    Remove,
}

/// The shape of an observation node in a trace tree. Mirrors the
/// observation taxonomy the Python observability layer ships to the cloud
/// (ADR-0012) — a `span` is a generic step, a `generation` is an LLM call, an
/// `event` is a point-in-time marker.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ObservationKind {
    Span,
    Generation,
    Event,
}

/// Terminal status of an observation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ObservationStatus {
    Ok,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SearchHitTrace {
    pub tool_id: String,
    pub score: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SearchStage {
    pub name: String,
    pub took_ms: u64,
    pub top_score: Option<f64>,
}

/// Every event produced by any layer of Ratel. New variants are additive;
/// renames or removals are breaking — see ADR-0009.
///
/// The observability variants (`TraceRoot`, `ObservationStart`, `ObservationEnd`,
/// `Generation`, `TokensSaved`) carry only trace-tree identity and coarse usage
/// facts — never prompt/output text or free-form payload. The rich payload lives
/// in the host SDK and is joined cloud-side by `trace_id`/`observation_id`, so
/// PII never enters the core or its on-disk JSONL (ADR-0012).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TraceEvent {
    Search {
        query: String,
        origin: Origin,
        top_k: u32,
        hits: Vec<SearchHitTrace>,
        stages: Vec<SearchStage>,
        took_ms: u64,
    },
    IndexChurn {
        kind: ChurnKind,
        tool_id: String,
    },
    InvokeStart {
        tool_id: String,
        args_size_bytes: u64,
    },
    InvokeEnd {
        tool_id: String,
        took_ms: u64,
    },
    InvokeError {
        tool_id: String,
        took_ms: u64,
        error: String,
    },
    GatewaySearch {
        query: String,
        origin: Origin,
        top_k: u32,
        hits: u32,
        took_ms: u64,
    },
    GatewayInvoke {
        tool_id: String,
        took_ms: u64,
    },
    GatewayError {
        tool_id: String,
        error: String,
    },
    UpstreamRegister {
        server: String,
        transport: String,
        tool_count: u32,
    },
    UpstreamInvoke {
        server: String,
        tool_id: String,
        took_ms: u64,
    },
    UpstreamError {
        server: String,
        tool_id: String,
        error: String,
    },
    AuthRefresh {
        upstream: String,
        ok: bool,
    },
    AuthNeeds {
        upstream: String,
    },
    AuthFlowStart {
        upstream: String,
    },
    AuthFlowEnd {
        upstream: String,
        ok: bool,
    },

    // --- Observability (ADR-0012): trace-tree identity + coarse usage, no PII. ---
    /// Root of a trace tree opened by the host SDK. Carries only non-PII trace
    /// identity/attributes — `user_id` and any rich payload stay in the host SDK's
    /// cloud stream, never the core or its on-disk JSONL (ADR-0012).
    TraceRoot {
        trace_id: String,
        name: String,
        tags: Vec<String>,
        version: Option<String>,
    },
    /// An observation node opened within a trace. `kind` distinguishes a generic
    /// span, an LLM generation, or a point-in-time event.
    ObservationStart {
        trace_id: String,
        observation_id: String,
        parent_observation_id: Option<String>,
        name: String,
        kind: ObservationKind,
    },
    /// An observation node closed, with its duration and terminal status.
    ObservationEnd {
        trace_id: String,
        observation_id: String,
        took_ms: u64,
        status: ObservationStatus,
        error: Option<String>,
    },
    /// Usage facts for an LLM generation, emitted on close alongside the matching
    /// `ObservationEnd`. Token counts are provider-reported when available.
    Generation {
        trace_id: String,
        observation_id: String,
        parent_observation_id: Option<String>,
        provider: String,
        model: String,
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
        total_tokens: Option<u64>,
    },
    /// Estimated context tokens saved by Ratel tool selection on a single search:
    /// the full registered catalog vs the selected top-K.
    TokensSaved {
        trace_id: String,
        full_catalog_tokens: u64,
        selected_tokens: u64,
        top_k: u32,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TraceEnvelope {
    pub v: u32,
    pub ts: u64,
    pub session_id: String,
    #[serde(flatten)]
    pub event: TraceEvent,
}
