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

#[napi(object)]
pub struct Tool {
    pub id: String,
    pub name: String,
    pub description: String,
    #[napi(ts_type = "import('json-schema').JSONSchema7")]
    pub input_schema: Value,
    #[napi(ts_type = "import('json-schema').JSONSchema7")]
    pub output_schema: Value,
}

#[napi(object)]
pub struct SearchHit {
    pub tool_id: String,
    pub score: f64,
}

#[napi(object)]
pub struct TraceSinkConfig {
    /// One of "noop" | "memory" | "jsonl".
    pub kind: String,
    /// Stamped on every envelope. Required for "memory" and "jsonl".
    pub session_id: Option<String>,
    /// Required for "jsonl".
    pub path: Option<String>,
}

#[napi]
pub struct ToolRegistry {
    inner: core::ToolRegistry,
    memory_sink: Option<Arc<MemorySink>>,
}

#[napi]
impl ToolRegistry {
    #[napi(constructor)]
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        Self {
            inner: core::ToolRegistry::new(),
            memory_sink: None,
        }
    }

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
    /// `bm25` is infallible; `semantic`/`hybrid` load the embedding model lazily
    /// and throw on a failed load. An unknown method string throws too.
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

    #[napi]
    pub fn record_event(&self, event: Value) -> napi::Result<()> {
        let event: TraceEvent = serde_json::from_value(event)
            .map_err(|e| napi::Error::from_reason(format!("invalid trace event: {e}")))?;
        self.inner.record_event(event);
        Ok(())
    }

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

#[napi(object)]
pub struct Skill {
    pub id: String,
    pub name: String,
    pub description: String,
    /// Author-declared labels and task phrases ("frontend", "login form");
    /// indexed for ranking. Optional (defaults to `[]`) — a minimal
    /// `Skill(id, name, description)` is valid, in parity with the Python SDK.
    pub tags: Option<Vec<String>>,
    /// Ids of tools this skill's instructions call; surfaced into the
    /// `search_capabilities` tools bucket — not indexed as query terms.
    pub tools: Option<Vec<String>>,
    /// Free-form, non-indexed context for higher layers — e.g.
    /// `{ stacks: ["react"] }` for the push ranker to boost by project context.
    pub metadata: Option<HashMap<String, Vec<String>>>,
    /// Optional (defaults to `""`) — parity with the Python SDK's default body.
    pub body: Option<String>,
}

#[napi(object)]
pub struct SkillHit {
    pub skill_id: String,
    pub score: f64,
}

#[napi]
pub struct SkillRegistry {
    inner: core::SkillRegistry,
    memory_sink: Option<Arc<MemorySink>>,
}

#[napi]
impl SkillRegistry {
    #[napi(constructor)]
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        Self {
            inner: core::SkillRegistry::new(),
            memory_sink: None,
        }
    }

    #[napi]
    pub fn register(&mut self, skill: Skill) {
        self.inner.register(core::Skill {
            id: skill.id,
            name: skill.name,
            description: skill.description,
            tags: skill.tags.unwrap_or_default(),
            tools: skill.tools.unwrap_or_default(),
            metadata: skill.metadata.unwrap_or_default(),
            body: skill.body.unwrap_or_default(),
        });
    }

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

    #[napi]
    pub fn record_event(&self, event: Value) -> napi::Result<()> {
        let event: TraceEvent = serde_json::from_value(event)
            .map_err(|e| napi::Error::from_reason(format!("invalid trace event: {e}")))?;
        self.inner.record_event(event);
        Ok(())
    }

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
