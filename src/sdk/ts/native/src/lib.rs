#![deny(clippy::all)]

#[macro_use]
extern crate napi_derive;

use std::collections::HashMap;
use std::sync::Arc;

use ratel_ai_core as core;
use ratel_ai_core::{JsonlSink, MemorySink, NoopSink, Origin, SearchMethod, TraceEvent};
use serde_json::Value;

/// A constructed sink plus the `MemorySink` handle when the kind is `"memory"`
/// (so the owner can drain it later).
type BuiltTraceSink = (Arc<dyn core::TraceSink>, Option<Arc<MemorySink>>);

/// Build a trace sink from a [`TraceSinkConfig`].
fn build_trace_sink(config: TraceSinkConfig) -> napi::Result<BuiltTraceSink> {
    match config.kind.as_str() {
        "noop" => Ok((Arc::new(NoopSink), None)),
        "memory" => {
            let session_id = config
                .session_id
                .ok_or_else(|| napi::Error::from_reason("memory sink requires sessionId"))?;
            let sink = Arc::new(MemorySink::new(session_id));
            Ok((sink.clone(), Some(sink)))
        }
        "jsonl" => {
            let session_id = config
                .session_id
                .ok_or_else(|| napi::Error::from_reason("jsonl sink requires sessionId"))?;
            let path = config
                .path
                .ok_or_else(|| napi::Error::from_reason("jsonl sink requires path"))?;
            let sink = JsonlSink::new(session_id, &path)
                .map_err(|e| napi::Error::from_reason(format!("open jsonl sink: {e}")))?;
            Ok((Arc::new(sink), None))
        }
        other => Err(napi::Error::from_reason(format!(
            "unknown trace sink kind: {other}"
        ))),
    }
}

/// A tool's searchable metadata: what the registry indexes and what a search
/// hit resolves back to. Execution lives a layer up (the SDK's `ToolCatalog`
/// pairs each `Tool` with its executor).
#[napi(object)]
pub struct Tool {
    /// Unique id, the registry key. Re-registering an existing id replaces the
    /// entry in place. MCP-proxied tools use the `<server>__<tool>` convention.
    pub id: String,
    /// Callable name (typically the same as `id` for local tools); indexed for
    /// ranking both whole and split on `snake_case`/`camelCase` boundaries.
    pub name: String,
    /// What the tool does and when to use it — the main ranking signal.
    pub description: String,
    /// JSON Schema of the arguments. Property names and their `description`s
    /// (nested included) are indexed for ranking.
    #[napi(ts_type = "import('json-schema').JSONSchema7")]
    pub input_schema: Value,
    /// JSON Schema of the result; indexed the same way as `inputSchema`.
    #[napi(ts_type = "import('json-schema').JSONSchema7")]
    pub output_schema: Value,
}

/// One ranked tool from a registry search, best-first.
#[napi(object)]
pub struct SearchHit {
    /// Id of the matched tool, as registered.
    pub tool_id: String,
    /// Relevance score; higher is better, ties break by id ascending. The scale
    /// depends on the method: raw BM25 (unbounded) for `"bm25"`, cosine
    /// similarity for `"semantic"`, Reciprocal Rank Fusion for `"hybrid"` —
    /// comparable within one result list, not across methods.
    pub score: f64,
}

/// Destination for the local trace stream (ADR-0007): `"noop"` discards,
/// `"memory"` buffers envelopes for `drainTraceEvents`, `"jsonl"` appends one
/// JSON envelope per line to `path`.
#[napi(object)]
pub struct TraceSinkConfig {
    /// One of "noop" | "memory" | "jsonl".
    pub kind: String,
    /// Stamped on every envelope. Required for "memory" and "jsonl".
    pub session_id: Option<String>,
    /// Required for "jsonl".
    pub path: Option<String>,
}

/// Node binding over the `ratel-ai-core` tool registry: an in-process index
/// that ranks registered tools against a natural-language query (BM25 by
/// default; semantic/hybrid once embeddings are built). Metadata-only — the
/// SDK's `ToolCatalog` layers executors, OTel spans, and defaults on top.
#[napi]
pub struct ToolRegistry {
    inner: core::ToolRegistry,
    memory_sink: Option<Arc<MemorySink>>,
}

#[napi]
impl ToolRegistry {
    /// Create an empty registry with a no-op trace sink.
    #[napi(constructor)]
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        Self {
            inner: core::ToolRegistry::new(),
            memory_sink: None,
        }
    }

    /// Index a tool, or replace one in place if its id is already registered
    /// (the corpus never holds a duplicate). Infallible and model-free; a
    /// semantic caller embeds afterwards via `buildEmbeddings`.
    #[napi]
    pub fn register(&mut self, tool: Tool) {
        self.inner.register(core::Tool {
            id: tool.id,
            name: tool.name,
            description: tool.description,
            input_schema: tool.input_schema,
            output_schema: tool.output_schema,
        });
    }

    /// Lexical BM25 search: up to `topK` hits, best-first with ties broken by
    /// id. Model-free and infallible; an empty registry returns `[]`. Records
    /// the query on the local trace stream with origin `"direct"`.
    #[napi]
    pub fn search(&self, query: String, top_k: u32) -> Vec<SearchHit> {
        self.inner
            .search(&query, top_k as usize)
            .into_iter()
            .map(|hit| SearchHit {
                tool_id: hit.tool_id,
                score: hit.score as f64,
            })
            .collect()
    }

    /// BM25 search with an explicit origin — `"agent"` for a call the model
    /// synthesized (capability tools), anything else counts as `"direct"`
    /// (host code). Origin only annotates the trace event; ranking is
    /// identical to `search`.
    #[napi]
    pub fn search_with_origin(&self, query: String, top_k: u32, origin: String) -> Vec<SearchHit> {
        let parsed = match origin.as_str() {
            "agent" => Origin::Agent,
            _ => Origin::Direct,
        };
        self.inner
            .search_with_origin(&query, top_k as usize, parsed)
            .into_iter()
            .map(|hit| SearchHit {
                tool_id: hit.tool_id,
                score: hit.score as f64,
            })
            .collect()
    }

    /// Search with an explicit method (`"bm25"` | `"semantic"` | `"hybrid"`).
    /// `bm25` is infallible; `semantic`/`hybrid` rank against the prebuilt embedding
    /// cache and throw (`EmbeddingsNotBuilt`) if it isn't built — the model loads at
    /// `build_embeddings`, never inside a search. An unknown method string throws too.
    #[napi]
    pub fn search_with_method(
        &self,
        query: String,
        top_k: u32,
        origin: String,
        method: String,
    ) -> napi::Result<Vec<SearchHit>> {
        let parsed_origin = match origin.as_str() {
            "agent" => Origin::Agent,
            _ => Origin::Direct,
        };
        let parsed_method: SearchMethod =
            method
                .parse()
                .map_err(|e: ratel_ai_core::ParseSearchMethodError| {
                    napi::Error::from_reason(e.to_string())
                })?;
        let hits = self
            .inner
            .search_with_method(&query, top_k as usize, parsed_origin, parsed_method)
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;
        Ok(hits
            .into_iter()
            .map(|hit| SearchHit {
                tool_id: hit.tool_id,
                score: hit.score as f64,
            })
            .collect())
    }

    /// Pre-compute embeddings for not-yet-embedded tools (incremental) so a later
    /// semantic/hybrid search only embeds the query. Throws if the model fails to
    /// load. The catalog calls this after `register` in semantic mode.
    #[napi]
    pub fn build_embeddings(&self) -> napi::Result<()> {
        self.inner
            .build_embeddings()
            .map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    /// Record a custom event on the local trace stream (ADR-0007). `event` is
    /// the tagged wire shape — `{ type: "...", ... }` with snake_case fields —
    /// and an object that doesn't parse as a known event throws
    /// (`invalid trace event`). Higher layers use this to put their
    /// invoke/upstream/auth lifecycle events on the same stream as the
    /// registry's own search events.
    #[napi]
    pub fn record_event(&self, event: Value) -> napi::Result<()> {
        let event: TraceEvent = serde_json::from_value(event)
            .map_err(|e| napi::Error::from_reason(format!("invalid trace event: {e}")))?;
        self.inner.record_event(event);
        Ok(())
    }

    /// Replace the trace sink; subsequent events go to the new destination,
    /// already-recorded ones are not replayed. Throws on an unknown `kind`, a
    /// missing `sessionId`/`path`, or a `"jsonl"` file that can't be opened.
    #[napi]
    pub fn set_trace_sink(&mut self, config: TraceSinkConfig) -> napi::Result<()> {
        let (sink, memory) = build_trace_sink(config)?;
        self.memory_sink = memory;
        self.inner.set_trace_sink(sink);
        Ok(())
    }

    /// Drain captured envelopes from the active sink. Returns `[]` unless the
    /// active sink is "memory".
    #[napi]
    pub fn drain_trace_events(&self) -> Vec<Value> {
        let Some(sink) = self.memory_sink.as_ref() else {
            return Vec::new();
        };
        sink.drain()
            .into_iter()
            .filter_map(|env| serde_json::to_value(&env).ok())
            .collect()
    }
}

/// A reusable playbook: instructions the agent *reads* and follows, in
/// contrast to a `Tool` it executes. Name, description, and tags are indexed
/// for ranking; the `body` is the dispatch payload, deliberately excluded from
/// the index so it can't drown the description's term weights.
#[napi(object)]
pub struct Skill {
    /// Unique id, the registry key. Re-registering an existing id replaces the
    /// entry in place.
    pub id: String,
    /// Human-readable name; indexed for ranking both whole and split on
    /// `snake_case`/`camelCase` boundaries.
    pub name: String,
    /// What the skill covers and when to reach for it — the main ranking signal.
    pub description: String,
    /// Author-declared labels and task phrases ("frontend", "login form");
    /// indexed for ranking. Optional (defaults to `[]`) — a minimal
    /// `Skill(id, name, description)` is valid, in parity with the Python SDK.
    pub tags: Option<Vec<String>>,
    /// Ids of tools this skill's instructions call; surfaced into the
    /// `search_capabilities` tools bucket — not indexed as query terms.
    pub tools: Option<Vec<String>>,
    /// Ids of skills this skill's instructions reference — a dependency edge
    /// for higher layers, not indexed as query terms.
    pub skills: Option<Vec<String>>,
    /// Free-form, non-indexed context for higher layers — e.g.
    /// `{ stacks: ["react"] }` for the push ranker to boost by project context.
    pub metadata: Option<HashMap<String, Vec<String>>>,
    /// The full instructions (Markdown) returned on load — the dispatch
    /// payload, never indexed for ranking.
    /// Optional (defaults to `""`) — parity with the Python SDK's default body.
    pub body: Option<String>,
}

/// One ranked skill from a registry search, best-first — the skill twin of
/// `SearchHit`, with the same score semantics per method.
#[napi(object)]
pub struct SkillHit {
    /// Id of the matched skill, as registered.
    pub skill_id: String,
    /// Relevance score; higher is better, ties break by id ascending. Scale
    /// depends on the method (BM25 / cosine / RRF), as on `SearchHit.score`.
    pub score: f64,
}

/// Node binding over the `ratel-ai-core` skill registry — the skill twin of
/// `ToolRegistry`, ranking registered skills against a natural-language query.
/// Skill bodies are stored but never indexed; fetch them a layer up (the SDK's
/// `SkillCatalog.invoke`).
#[napi]
pub struct SkillRegistry {
    inner: core::SkillRegistry,
    memory_sink: Option<Arc<MemorySink>>,
}

#[napi]
impl SkillRegistry {
    /// Create an empty registry with a no-op trace sink.
    #[napi(constructor)]
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        Self {
            inner: core::SkillRegistry::new(),
            memory_sink: None,
        }
    }

    /// Index a skill, or replace one in place if its id is already registered.
    /// Omitted optional fields default to empty (`tags`/`tools`/`metadata`)
    /// and `""` (`body`). See `ToolRegistry.register`.
    #[napi]
    pub fn register(&mut self, skill: Skill) {
        self.inner.register(core::Skill {
            id: skill.id,
            name: skill.name,
            description: skill.description,
            tags: skill.tags.unwrap_or_default(),
            tools: skill.tools.unwrap_or_default(),
            skills: skill.skills.unwrap_or_default(),
            metadata: skill.metadata.unwrap_or_default(),
            body: skill.body.unwrap_or_default(),
        });
    }

    /// Lexical BM25 search over skills — see `ToolRegistry.search` for the
    /// contract (best-first, ties by id, infallible, traced as `"direct"`).
    #[napi]
    pub fn search(&self, query: String, top_k: u32) -> Vec<SkillHit> {
        self.inner
            .search(&query, top_k as usize)
            .into_iter()
            .map(|hit| SkillHit {
                skill_id: hit.skill_id,
                score: hit.score as f64,
            })
            .collect()
    }

    /// BM25 search with an explicit origin — see `ToolRegistry.searchWithOrigin`.
    #[napi]
    pub fn search_with_origin(&self, query: String, top_k: u32, origin: String) -> Vec<SkillHit> {
        let parsed = match origin.as_str() {
            "agent" => Origin::Agent,
            _ => Origin::Direct,
        };
        self.inner
            .search_with_origin(&query, top_k as usize, parsed)
            .into_iter()
            .map(|hit| SkillHit {
                skill_id: hit.skill_id,
                score: hit.score as f64,
            })
            .collect()
    }

    /// Search with an explicit method — see [`ToolRegistry::search_with_method`].
    #[napi]
    pub fn search_with_method(
        &self,
        query: String,
        top_k: u32,
        origin: String,
        method: String,
    ) -> napi::Result<Vec<SkillHit>> {
        let parsed_origin = match origin.as_str() {
            "agent" => Origin::Agent,
            _ => Origin::Direct,
        };
        let parsed_method: SearchMethod =
            method
                .parse()
                .map_err(|e: ratel_ai_core::ParseSearchMethodError| {
                    napi::Error::from_reason(e.to_string())
                })?;
        let hits = self
            .inner
            .search_with_method(&query, top_k as usize, parsed_origin, parsed_method)
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;
        Ok(hits
            .into_iter()
            .map(|hit| SkillHit {
                skill_id: hit.skill_id,
                score: hit.score as f64,
            })
            .collect())
    }

    /// See `ToolRegistry.build_embeddings`.
    #[napi]
    pub fn build_embeddings(&self) -> napi::Result<()> {
        self.inner
            .build_embeddings()
            .map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    /// Record a custom event on the local trace stream — see
    /// `ToolRegistry.recordEvent`. Throws on an object that doesn't parse as a
    /// known trace event.
    #[napi]
    pub fn record_event(&self, event: Value) -> napi::Result<()> {
        let event: TraceEvent = serde_json::from_value(event)
            .map_err(|e| napi::Error::from_reason(format!("invalid trace event: {e}")))?;
        self.inner.record_event(event);
        Ok(())
    }

    /// Replace the trace sink — see `ToolRegistry.setTraceSink`.
    #[napi]
    pub fn set_trace_sink(&mut self, config: TraceSinkConfig) -> napi::Result<()> {
        let (sink, memory) = build_trace_sink(config)?;
        self.memory_sink = memory;
        self.inner.set_trace_sink(sink);
        Ok(())
    }

    /// Drain captured envelopes from the active sink. Returns `[]` unless the
    /// active sink is "memory".
    #[napi]
    pub fn drain_trace_events(&self) -> Vec<Value> {
        let Some(sink) = self.memory_sink.as_ref() else {
            return Vec::new();
        };
        sink.drain()
            .into_iter()
            .filter_map(|env| serde_json::to_value(&env).ok())
            .collect()
    }
}
