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

/// Coarse retryability split for error events: `Transient` failures may
/// succeed on retry (auth, rate limits, network); `Permanent` ones won't
/// (unknown ids, invalid args). The free-form `error` string stays authoritative.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    Transient,
    Permanent,
}

/// A ranked tool hit on `gateway_search`. `rank` is explicit (0-based) so the
/// value survives re-ordering downstream; on `search`/`skill_search` array
/// order is the rank.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GatewayToolHitTrace {
    pub tool_id: String,
    pub score: f64,
    pub rank: u32,
}

/// A ranked skill hit on `gateway_search` — see [`GatewayToolHitTrace`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GatewaySkillHitTrace {
    pub skill_id: String,
    pub score: f64,
    pub rank: u32,
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        search_id: Option<String>,
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        search_id: Option<String>,
    },
    SkillChurn {
        kind: ChurnKind,
        skill_id: String,
    },
    SkillInvoke {
        skill_id: String,
        took_ms: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        search_id: Option<String>,
    },
    InvokeStart {
        tool_id: String,
        args_size_bytes: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        search_id: Option<String>,
    },
    InvokeEnd {
        tool_id: String,
        took_ms: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        search_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result_size_bytes: Option<u64>,
    },
    InvokeError {
        tool_id: String,
        took_ms: u64,
        error: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        search_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error_code: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error_kind: Option<ErrorKind>,
    },
    GatewaySearch {
        query: String,
        origin: Origin,
        top_k: u32,
        /// Total hit count. Stays a bare count for wire compatibility
        /// (ADR-0013); per-hit detail rides `tool_hits` / `skill_hits`.
        hits: u32,
        took_ms: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        search_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool_hits: Option<Vec<GatewayToolHitTrace>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        skill_hits: Option<Vec<GatewaySkillHitTrace>>,
    },
    GatewayInvoke {
        tool_id: String,
        took_ms: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        search_id: Option<String>,
    },
    GatewayError {
        tool_id: String,
        error: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error_code: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error_kind: Option<ErrorKind>,
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error_code: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error_kind: Option<ErrorKind>,
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
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TraceEnvelope {
    pub v: u32,
    pub ts: u64,
    pub session_id: String,
    /// Per-session monotonic counter. `(session_id, seq)` is unique only when
    /// every producer stamps through one shared session — see ADR-0013.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub harness: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sdk_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog_version: Option<String>,
    #[serde(flatten)]
    pub event: TraceEvent,
}
