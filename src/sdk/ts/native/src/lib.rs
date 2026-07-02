#![deny(clippy::all)]

#[macro_use]
extern crate napi_derive;

use std::collections::HashMap;
use std::sync::Arc;

use ratel_ai_core as core;
use ratel_ai_core::{EnvelopeStamper, JsonlSink, MemorySink, NoopSink, Origin, TraceEvent};
use serde_json::Value;

/// A constructed sink plus the `MemorySink` handle when the kind is `"memory"`
/// (so the owner can drain it later).
type BuiltTraceSink = (Arc<dyn core::TraceSink>, Option<Arc<MemorySink>>);

fn build_stamper(
    session_id: String,
    harness: Option<String>,
    environment: Option<String>,
    sdk_version: Option<String>,
    catalog_version: Option<String>,
) -> EnvelopeStamper {
    let mut stamper = EnvelopeStamper::new(session_id);
    if let Some(harness) = harness {
        stamper = stamper.with_harness(harness);
    }
    if let Some(environment) = environment {
        stamper = stamper.with_environment(environment);
    }
    if let Some(sdk_version) = sdk_version {
        stamper = stamper.with_sdk_version(sdk_version);
    }
    if let Some(catalog_version) = catalog_version {
        stamper = stamper.with_catalog_version(catalog_version);
    }
    stamper
}

/// Build a trace sink from a [`TraceSinkConfig`].
fn build_trace_sink(config: TraceSinkConfig) -> napi::Result<BuiltTraceSink> {
    match config.kind.as_str() {
        "noop" => Ok((Arc::new(NoopSink), None)),
        "memory" => {
            let session_id = config
                .session_id
                .ok_or_else(|| napi::Error::from_reason("memory sink requires sessionId"))?;
            let stamper = build_stamper(
                session_id,
                config.harness,
                config.environment,
                config.sdk_version,
                config.catalog_version,
            );
            let sink = Arc::new(MemorySink::with_stamper(Arc::new(stamper)));
            Ok((sink.clone(), Some(sink)))
        }
        "jsonl" => {
            let session_id = config
                .session_id
                .ok_or_else(|| napi::Error::from_reason("jsonl sink requires sessionId"))?;
            let path = config
                .path
                .ok_or_else(|| napi::Error::from_reason("jsonl sink requires path"))?;
            let stamper = build_stamper(
                session_id,
                config.harness,
                config.environment,
                config.sdk_version,
                config.catalog_version,
            );
            let sink = JsonlSink::with_stamper(Arc::new(stamper), &path)
                .map_err(|e| napi::Error::from_reason(format!("open jsonl sink: {e}")))?;
            Ok((Arc::new(sink), None))
        }
        other => Err(napi::Error::from_reason(format!(
            "unknown trace sink kind: {other}"
        ))),
    }
}

/// Default event capacity for a [`TraceSession`] buffer — past this, the
/// oldest events drop (ADR-0013 query-log semantics).
const DEFAULT_SESSION_CAPACITY: u32 = 10_000;

#[napi(object)]
pub struct TraceSessionConfig {
    pub session_id: String,
    /// e.g. "claude-code" — stamped on every envelope.
    pub harness: Option<String>,
    /// e.g. "dev" | "ci" | "prod".
    pub environment: Option<String>,
    pub sdk_version: Option<String>,
    pub catalog_version: Option<String>,
    /// Buffer bound (drop-oldest). Defaults to 10_000.
    pub capacity: Option<u32>,
}

/// One shared, bounded trace buffer for a whole session: attach it to every
/// catalog so `(session_id, seq)` is unique and there is a single drain point
/// for the Cloud exporter. See ADR-0013.
#[napi]
pub struct TraceSession {
    sink: Arc<MemorySink>,
}

#[napi]
impl TraceSession {
    #[napi(constructor)]
    pub fn new(config: TraceSessionConfig) -> Self {
        let stamper = build_stamper(
            config.session_id,
            config.harness,
            config.environment,
            config.sdk_version,
            config.catalog_version,
        );
        let capacity = config.capacity.unwrap_or(DEFAULT_SESSION_CAPACITY) as usize;
        Self {
            sink: Arc::new(MemorySink::with_stamper(Arc::new(stamper)).with_capacity(capacity)),
        }
    }

    /// Drain all buffered envelopes. A session should have exactly one
    /// drainer (typically the Cloud exporter).
    #[napi]
    pub fn drain(&self) -> Vec<Value> {
        self.sink
            .drain()
            .into_iter()
            .filter_map(|env| serde_json::to_value(&env).ok())
            .collect()
    }

    /// Re-point the catalog version stamped on subsequent envelopes (the
    /// catalog-sync layer calls this on every version change).
    #[napi]
    pub fn set_catalog_version(&self, catalog_version: Option<String>) {
        self.sink.stamper().set_catalog_version(catalog_version);
    }

    /// Events dropped to the capacity bound since construction.
    #[napi]
    pub fn dropped_count(&self) -> i64 {
        self.sink.dropped_count() as i64
    }

    #[napi(getter)]
    pub fn session_id(&self) -> String {
        self.sink.session_id().to_string()
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
    /// Optional envelope context — see [`TraceSessionConfig`]. Note: a
    /// per-registry sink gets its own seq counter; use `TraceSession` for a
    /// session-unique `(session_id, seq)`.
    pub harness: Option<String>,
    pub environment: Option<String>,
    pub sdk_version: Option<String>,
    pub catalog_version: Option<String>,
}

#[napi(object)]
pub struct SearchOutcome {
    /// The id stamped on the emitted `search` event — attach it to the
    /// invokes this search led to (ADR-0013).
    pub search_id: String,
    pub hits: Vec<SearchHit>,
}

#[napi(object)]
pub struct SkillSearchOutcome {
    pub search_id: String,
    pub hits: Vec<SkillHit>,
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

    /// Like `searchWithOrigin`, but also returns the `search_id` stamped on
    /// the emitted event.
    #[napi]
    pub fn search_with_trace(&self, query: String, top_k: u32, origin: String) -> SearchOutcome {
        let parsed = match origin.as_str() {
            "agent" => Origin::Agent,
            _ => Origin::Direct,
        };
        let outcome = self.inner.search_traced(&query, top_k as usize, parsed);
        SearchOutcome {
            search_id: outcome.search_id,
            hits: outcome
                .hits
                .into_iter()
                .map(|hit| SearchHit {
                    tool_id: hit.tool_id,
                    score: hit.score as f64,
                })
                .collect(),
        }
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

    /// Route this registry's events into a shared [`TraceSession`] buffer.
    #[napi]
    pub fn attach_trace_session(&mut self, session: &TraceSession) {
        self.memory_sink = Some(session.sink.clone());
        self.inner.set_trace_sink(session.sink.clone());
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

fn to_core_skill(skill: Skill) -> core::Skill {
    core::Skill {
        id: skill.id,
        name: skill.name,
        description: skill.description,
        tags: skill.tags.unwrap_or_default(),
        tools: skill.tools.unwrap_or_default(),
        metadata: skill.metadata.unwrap_or_default(),
        body: skill.body.unwrap_or_default(),
    }
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
        self.inner.register(to_core_skill(skill));
    }

    /// Register-or-replace by id (collapses historical duplicates). Emits
    /// `Remove` + `Add` churn on replacement. Returns whether something was
    /// replaced.
    #[napi]
    pub fn upsert(&mut self, skill: Skill) -> bool {
        self.inner.upsert(to_core_skill(skill))
    }

    /// Remove every skill with the given id. Returns whether anything was
    /// removed.
    #[napi]
    pub fn remove(&mut self, skill_id: String) -> bool {
        self.inner.remove(&skill_id)
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

    /// Like `searchWithOrigin`, but also returns the `search_id` stamped on
    /// the emitted event.
    #[napi]
    pub fn search_with_trace(
        &self,
        query: String,
        top_k: u32,
        origin: String,
    ) -> SkillSearchOutcome {
        let parsed = match origin.as_str() {
            "agent" => Origin::Agent,
            _ => Origin::Direct,
        };
        let outcome = self.inner.search_traced(&query, top_k as usize, parsed);
        SkillSearchOutcome {
            search_id: outcome.search_id,
            hits: outcome
                .hits
                .into_iter()
                .map(|hit| SkillHit {
                    skill_id: hit.skill_id,
                    score: hit.score as f64,
                })
                .collect(),
        }
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

    /// Route this registry's events into a shared [`TraceSession`] buffer.
    #[napi]
    pub fn attach_trace_session(&mut self, session: &TraceSession) {
        self.memory_sink = Some(session.sink.clone());
        self.inner.set_trace_sink(session.sink.clone());
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
