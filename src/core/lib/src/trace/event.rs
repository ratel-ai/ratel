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

/// Outcome of the one-time embedding-model load. `Slow` flags a machine that may
/// be underpowered for the model; `Failed` a load that errored (network, cache,
/// corrupt weights).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EmbedderLoadStatus {
    Ok,
    Slow,
    Failed,
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SkillHitTrace {
    pub skill_id: String,
    pub score: f64,
}

/// Every event produced by any layer of Ratel. New variants are additive;
/// renames or removals are breaking — see ADR-0009.
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
    SkillSearch {
        query: String,
        origin: Origin,
        top_k: u32,
        hits: Vec<SkillHitTrace>,
        stages: Vec<SearchStage>,
        took_ms: u64,
    },
    SkillChurn {
        kind: ChurnKind,
        skill_id: String,
    },
    SkillInvoke {
        skill_id: String,
        took_ms: u64,
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
    /// Emitted once, on the first (cold) load of the embedding model. `status`
    /// flags a slow load (possibly underpowered machine) or a failed one;
    /// `reason` carries the hint / error. See `embedding.rs` and ADR-0013.
    EmbedderLoad {
        model: String,
        status: EmbedderLoadStatus,
        took_ms: u64,
        reason: Option<String>,
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
