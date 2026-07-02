//! PyO3 binding to `ratel-ai-core` — the Python analogue of the TS SDK's NAPI
//! binding (`src/sdk/ts/native/src/lib.rs`). Pure pass-through over the public
//! API of `ratel-ai-core`; see ADR-0011 for the binding-strategy rationale and
//! ADR-0009 for the core-owned trace schema this emits into.

use std::collections::HashMap;
use std::sync::Arc;

use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use pyo3::types::PyList;
use ratel_ai_core as core;
use ratel_ai_core::{EnvelopeStamper, JsonlSink, MemorySink, NoopSink, Origin, TraceEvent};
use serde_json::Value;

/// Default event capacity for a [`TraceSession`] buffer — past this, the
/// oldest events drop (ADR-0013 query-log semantics).
const DEFAULT_SESSION_CAPACITY: usize = 10_000;

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

fn parse_origin(origin: &str) -> Origin {
    match origin {
        "agent" => Origin::Agent,
        _ => Origin::Direct,
    }
}

/// One shared, bounded trace buffer for a whole session: attach it to every
/// registry so `(session_id, seq)` is unique and there is a single drain
/// point for the Cloud exporter. See ADR-0013. Mirrors the TS `TraceSession`.
#[pyclass]
pub struct TraceSession {
    sink: Arc<MemorySink>,
}

#[pymethods]
impl TraceSession {
    #[new]
    #[pyo3(signature = (session_id, harness=None, environment=None, sdk_version=None, catalog_version=None, capacity=None))]
    fn new(
        session_id: String,
        harness: Option<String>,
        environment: Option<String>,
        sdk_version: Option<String>,
        catalog_version: Option<String>,
        capacity: Option<usize>,
    ) -> Self {
        let stamper = build_stamper(
            session_id,
            harness,
            environment,
            sdk_version,
            catalog_version,
        );
        let capacity = capacity.unwrap_or(DEFAULT_SESSION_CAPACITY);
        Self {
            sink: Arc::new(MemorySink::with_stamper(Arc::new(stamper)).with_capacity(capacity)),
        }
    }

    /// Drain all buffered envelopes. A session should have exactly one
    /// drainer (typically the Cloud exporter).
    fn drain<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyList>> {
        let out = PyList::empty(py);
        for env in self.sink.drain() {
            let obj = pythonize::pythonize(py, &env)
                .map_err(|e| PyValueError::new_err(format!("serialize trace envelope: {e}")))?;
            out.append(obj)?;
        }
        Ok(out)
    }

    /// Re-point the catalog version stamped on subsequent envelopes.
    #[pyo3(signature = (catalog_version=None))]
    fn set_catalog_version(&self, catalog_version: Option<String>) {
        self.sink.stamper().set_catalog_version(catalog_version);
    }

    /// Events dropped to the capacity bound since construction.
    fn dropped_count(&self) -> u64 {
        self.sink.dropped_count()
    }

    #[getter]
    fn session_id(&self) -> String {
        self.sink.session_id().to_string()
    }
}

/// A single search result: the matched tool id and its BM25 score. Mirrors the
/// TS SDK's `SearchHit` (camelCase `toolId` there → snake_case `tool_id` here).
#[pyclass(frozen)]
pub struct SearchHit {
    #[pyo3(get)]
    pub tool_id: String,
    #[pyo3(get)]
    pub score: f64,
}

#[pymethods]
impl SearchHit {
    fn __repr__(&self) -> String {
        format!(
            "SearchHit(tool_id={:?}, score={})",
            self.tool_id, self.score
        )
    }
}

/// A single skill search result: the matched skill id and its BM25 score. The
/// skill analogue of [`SearchHit`] (`tool_id` → `skill_id`).
#[pyclass(frozen)]
pub struct SkillHit {
    #[pyo3(get)]
    pub skill_id: String,
    #[pyo3(get)]
    pub score: f64,
}

#[pymethods]
impl SkillHit {
    fn __repr__(&self) -> String {
        format!(
            "SkillHit(skill_id={:?}, score={})",
            self.skill_id, self.score
        )
    }
}

/// Metadata-only BM25 index over `ratel-ai-core`. Executors and the gateway /
/// MCP layers live in the pure-Python `ratel_ai` package above this binding.
#[pyclass]
pub struct ToolRegistry {
    inner: core::ToolRegistry,
    memory_sink: Option<Arc<MemorySink>>,
}

#[pymethods]
impl ToolRegistry {
    #[new]
    fn new() -> Self {
        Self {
            inner: core::ToolRegistry::new(),
            memory_sink: None,
        }
    }

    fn register(
        &mut self,
        id: String,
        name: String,
        description: String,
        input_schema: &Bound<'_, PyAny>,
        output_schema: &Bound<'_, PyAny>,
    ) -> PyResult<()> {
        let input_schema: Value = pythonize::depythonize(input_schema)
            .map_err(|e| PyValueError::new_err(format!("invalid input_schema: {e}")))?;
        let output_schema: Value = pythonize::depythonize(output_schema)
            .map_err(|e| PyValueError::new_err(format!("invalid output_schema: {e}")))?;
        self.inner.register(core::Tool {
            id,
            name,
            description,
            input_schema,
            output_schema,
        });
        Ok(())
    }

    fn search(&self, query: String, top_k: u32) -> Vec<SearchHit> {
        self.inner
            .search(&query, top_k as usize)
            .into_iter()
            .map(|hit| SearchHit {
                tool_id: hit.tool_id,
                score: hit.score as f64,
            })
            .collect()
    }

    fn search_with_origin(&self, query: String, top_k: u32, origin: String) -> Vec<SearchHit> {
        self.inner
            .search_with_origin(&query, top_k as usize, parse_origin(&origin))
            .into_iter()
            .map(|hit| SearchHit {
                tool_id: hit.tool_id,
                score: hit.score as f64,
            })
            .collect()
    }

    /// Like `search_with_origin`, but also returns the `search_id` stamped on
    /// the emitted event, as a `(search_id, hits)` tuple.
    fn search_with_trace(
        &self,
        query: String,
        top_k: u32,
        origin: String,
    ) -> (String, Vec<SearchHit>) {
        let outcome = self
            .inner
            .search_traced(&query, top_k as usize, parse_origin(&origin));
        (
            outcome.search_id,
            outcome
                .hits
                .into_iter()
                .map(|hit| SearchHit {
                    tool_id: hit.tool_id,
                    score: hit.score as f64,
                })
                .collect(),
        )
    }

    fn record_event(&self, event: &Bound<'_, PyAny>) -> PyResult<()> {
        let value: Value = pythonize::depythonize(event)
            .map_err(|e| PyValueError::new_err(format!("invalid trace event: {e}")))?;
        let event: TraceEvent = serde_json::from_value(value)
            .map_err(|e| PyValueError::new_err(format!("invalid trace event: {e}")))?;
        self.inner.record_event(event);
        Ok(())
    }

    #[pyo3(signature = (kind, session_id=None, path=None, harness=None, environment=None, sdk_version=None, catalog_version=None))]
    #[allow(clippy::too_many_arguments)]
    fn set_trace_sink(
        &mut self,
        kind: String,
        session_id: Option<String>,
        path: Option<String>,
        harness: Option<String>,
        environment: Option<String>,
        sdk_version: Option<String>,
        catalog_version: Option<String>,
    ) -> PyResult<()> {
        match kind.as_str() {
            "noop" => {
                self.memory_sink = None;
                self.inner.set_trace_sink(Arc::new(NoopSink));
            }
            "memory" => {
                let session_id = session_id
                    .ok_or_else(|| PyValueError::new_err("memory sink requires session_id"))?;
                let stamper = build_stamper(
                    session_id,
                    harness,
                    environment,
                    sdk_version,
                    catalog_version,
                );
                let sink = Arc::new(MemorySink::with_stamper(Arc::new(stamper)));
                self.memory_sink = Some(sink.clone());
                self.inner.set_trace_sink(sink);
            }
            "jsonl" => {
                let session_id = session_id
                    .ok_or_else(|| PyValueError::new_err("jsonl sink requires session_id"))?;
                let path = path.ok_or_else(|| PyValueError::new_err("jsonl sink requires path"))?;
                let stamper = build_stamper(
                    session_id,
                    harness,
                    environment,
                    sdk_version,
                    catalog_version,
                );
                let sink = JsonlSink::with_stamper(Arc::new(stamper), &path)
                    .map_err(|e| PyValueError::new_err(format!("open jsonl sink: {e}")))?;
                self.memory_sink = None;
                self.inner.set_trace_sink(Arc::new(sink));
            }
            other => {
                return Err(PyValueError::new_err(format!(
                    "unknown trace sink kind: {other}"
                )));
            }
        }
        Ok(())
    }

    /// Route this registry's events into a shared [`TraceSession`] buffer.
    fn attach_trace_session(&mut self, session: PyRef<'_, TraceSession>) {
        self.memory_sink = Some(session.sink.clone());
        self.inner.set_trace_sink(session.sink.clone());
    }

    /// Drain captured envelopes from the active sink. Returns `[]` unless the
    /// active sink is "memory".
    fn drain_trace_events<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyList>> {
        let out = PyList::empty(py);
        let Some(sink) = self.memory_sink.as_ref() else {
            return Ok(out);
        };
        for env in sink.drain() {
            let obj = pythonize::pythonize(py, &env)
                .map_err(|e| PyValueError::new_err(format!("serialize trace envelope: {e}")))?;
            out.append(obj)?;
        }
        Ok(out)
    }
}

/// Metadata-only BM25 index over the skill corpus — the on-demand analogue of
/// [`ToolRegistry`]. A separate index, so skills are ranked independently of
/// tools (own corpus statistics, own top-K).
#[pyclass]
pub struct SkillRegistry {
    inner: core::SkillRegistry,
    memory_sink: Option<Arc<MemorySink>>,
}

#[pymethods]
impl SkillRegistry {
    #[new]
    fn new() -> Self {
        Self {
            inner: core::SkillRegistry::new(),
            memory_sink: None,
        }
    }

    // Mirrors `ToolRegistry::register`'s flat-param style (PyO3 has no by-value
    // object arg like the TS NAPI `Skill`); a skill simply has more fields.
    #[allow(clippy::too_many_arguments)]
    fn register(
        &mut self,
        id: String,
        name: String,
        description: String,
        tags: Vec<String>,
        tools: Vec<String>,
        metadata: HashMap<String, Vec<String>>,
        body: String,
    ) {
        self.inner.register(core::Skill {
            id,
            name,
            description,
            tags,
            tools,
            metadata,
            body,
        });
    }

    /// Register-or-replace by id (collapses historical duplicates). Emits
    /// `Remove` + `Add` churn on replacement. Returns whether something was
    /// replaced.
    #[allow(clippy::too_many_arguments)]
    fn upsert(
        &mut self,
        id: String,
        name: String,
        description: String,
        tags: Vec<String>,
        tools: Vec<String>,
        metadata: HashMap<String, Vec<String>>,
        body: String,
    ) -> bool {
        self.inner.upsert(core::Skill {
            id,
            name,
            description,
            tags,
            tools,
            metadata,
            body,
        })
    }

    /// Remove every skill with the given id. Returns whether anything was
    /// removed.
    fn remove(&mut self, skill_id: String) -> bool {
        self.inner.remove(&skill_id)
    }

    fn search(&self, query: String, top_k: u32) -> Vec<SkillHit> {
        self.inner
            .search(&query, top_k as usize)
            .into_iter()
            .map(|hit| SkillHit {
                skill_id: hit.skill_id,
                score: hit.score as f64,
            })
            .collect()
    }

    fn search_with_origin(&self, query: String, top_k: u32, origin: String) -> Vec<SkillHit> {
        self.inner
            .search_with_origin(&query, top_k as usize, parse_origin(&origin))
            .into_iter()
            .map(|hit| SkillHit {
                skill_id: hit.skill_id,
                score: hit.score as f64,
            })
            .collect()
    }

    /// Like `search_with_origin`, but also returns the `search_id` stamped on
    /// the emitted event, as a `(search_id, hits)` tuple.
    fn search_with_trace(
        &self,
        query: String,
        top_k: u32,
        origin: String,
    ) -> (String, Vec<SkillHit>) {
        let outcome = self
            .inner
            .search_traced(&query, top_k as usize, parse_origin(&origin));
        (
            outcome.search_id,
            outcome
                .hits
                .into_iter()
                .map(|hit| SkillHit {
                    skill_id: hit.skill_id,
                    score: hit.score as f64,
                })
                .collect(),
        )
    }

    fn record_event(&self, event: &Bound<'_, PyAny>) -> PyResult<()> {
        let value: Value = pythonize::depythonize(event)
            .map_err(|e| PyValueError::new_err(format!("invalid trace event: {e}")))?;
        let event: TraceEvent = serde_json::from_value(value)
            .map_err(|e| PyValueError::new_err(format!("invalid trace event: {e}")))?;
        self.inner.record_event(event);
        Ok(())
    }

    #[pyo3(signature = (kind, session_id=None, path=None, harness=None, environment=None, sdk_version=None, catalog_version=None))]
    #[allow(clippy::too_many_arguments)]
    fn set_trace_sink(
        &mut self,
        kind: String,
        session_id: Option<String>,
        path: Option<String>,
        harness: Option<String>,
        environment: Option<String>,
        sdk_version: Option<String>,
        catalog_version: Option<String>,
    ) -> PyResult<()> {
        match kind.as_str() {
            "noop" => {
                self.memory_sink = None;
                self.inner.set_trace_sink(Arc::new(NoopSink));
            }
            "memory" => {
                let session_id = session_id
                    .ok_or_else(|| PyValueError::new_err("memory sink requires session_id"))?;
                let stamper = build_stamper(
                    session_id,
                    harness,
                    environment,
                    sdk_version,
                    catalog_version,
                );
                let sink = Arc::new(MemorySink::with_stamper(Arc::new(stamper)));
                self.memory_sink = Some(sink.clone());
                self.inner.set_trace_sink(sink);
            }
            "jsonl" => {
                let session_id = session_id
                    .ok_or_else(|| PyValueError::new_err("jsonl sink requires session_id"))?;
                let path = path.ok_or_else(|| PyValueError::new_err("jsonl sink requires path"))?;
                let stamper = build_stamper(
                    session_id,
                    harness,
                    environment,
                    sdk_version,
                    catalog_version,
                );
                let sink = JsonlSink::with_stamper(Arc::new(stamper), &path)
                    .map_err(|e| PyValueError::new_err(format!("open jsonl sink: {e}")))?;
                self.memory_sink = None;
                self.inner.set_trace_sink(Arc::new(sink));
            }
            other => {
                return Err(PyValueError::new_err(format!(
                    "unknown trace sink kind: {other}"
                )));
            }
        }
        Ok(())
    }

    /// Route this registry's events into a shared [`TraceSession`] buffer.
    fn attach_trace_session(&mut self, session: PyRef<'_, TraceSession>) {
        self.memory_sink = Some(session.sink.clone());
        self.inner.set_trace_sink(session.sink.clone());
    }

    fn drain_trace_events<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyList>> {
        let out = PyList::empty(py);
        let Some(sink) = self.memory_sink.as_ref() else {
            return Ok(out);
        };
        for env in sink.drain() {
            let obj = pythonize::pythonize(py, &env)
                .map_err(|e| PyValueError::new_err(format!("serialize trace envelope: {e}")))?;
            out.append(obj)?;
        }
        Ok(out)
    }
}

#[pymodule]
fn _native(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<ToolRegistry>()?;
    m.add_class::<SearchHit>()?;
    m.add_class::<SkillRegistry>()?;
    m.add_class::<SkillHit>()?;
    m.add_class::<TraceSession>()?;
    Ok(())
}
