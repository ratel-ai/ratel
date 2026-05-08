#![deny(clippy::all)]

#[macro_use]
extern crate napi_derive;

use std::sync::Arc;

use ratel_ai_core as core;
use ratel_ai_core::{JsonlSink, MemorySink, NoopSink, Origin, TraceEvent};
use serde_json::Value;

#[napi(object)]
pub struct Tool {
    pub id: String,
    pub name: String,
    pub description: String,
    pub input_schema: Value,
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
            _ => Origin::User,
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

    #[napi]
    pub fn record_event(&self, event: Value) -> napi::Result<()> {
        let event: TraceEvent = serde_json::from_value(event)
            .map_err(|e| napi::Error::from_reason(format!("invalid trace event: {e}")))?;
        self.inner.record_event(event);
        Ok(())
    }

    #[napi]
    pub fn set_trace_sink(&mut self, config: TraceSinkConfig) -> napi::Result<()> {
        match config.kind.as_str() {
            "noop" => {
                self.memory_sink = None;
                self.inner.set_trace_sink(Arc::new(NoopSink));
            }
            "memory" => {
                let session_id = config
                    .session_id
                    .ok_or_else(|| napi::Error::from_reason("memory sink requires sessionId"))?;
                let sink = Arc::new(MemorySink::new(session_id));
                self.memory_sink = Some(sink.clone());
                self.inner.set_trace_sink(sink);
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
                self.memory_sink = None;
                self.inner.set_trace_sink(Arc::new(sink));
            }
            other => {
                return Err(napi::Error::from_reason(format!(
                    "unknown trace sink kind: {other}"
                )));
            }
        }
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
