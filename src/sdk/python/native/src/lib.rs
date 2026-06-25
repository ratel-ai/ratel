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
use ratel_ai_core::{JsonlSink, MemorySink, NoopSink, Origin, TraceEvent};
use serde_json::Value;

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

    /// Dense (semantic) retrieval — mirrors [`Self::search_with_origin`] but
    /// ranks by embedding cosine. Only present in dense-enabled builds.
    #[cfg(feature = "dense-search")]
    #[pyo3(signature = (query, top_k, origin=None))]
    fn search_dense(&self, query: String, top_k: u32, origin: Option<String>) -> Vec<SearchHit> {
        let parsed = match origin.as_deref() {
            Some("agent") => Origin::Agent,
            _ => Origin::Direct,
        };
        self.inner
            .search_dense_with_origin(&query, top_k as usize, parsed)
            .into_iter()
            .map(|hit| SearchHit {
                tool_id: hit.tool_id,
                score: hit.score as f64,
            })
            .collect()
    }

    fn record_event(&self, event: &Bound<'_, PyAny>) -> PyResult<()> {
        let value: Value = pythonize::depythonize(event)
            .map_err(|e| PyValueError::new_err(format!("invalid trace event: {e}")))?;
        let event: TraceEvent = serde_json::from_value(value)
            .map_err(|e| PyValueError::new_err(format!("invalid trace event: {e}")))?;
        self.inner.record_event(event);
        Ok(())
    }

    #[pyo3(signature = (kind, session_id=None, path=None))]
    fn set_trace_sink(
        &mut self,
        kind: String,
        session_id: Option<String>,
        path: Option<String>,
    ) -> PyResult<()> {
        match kind.as_str() {
            "noop" => {
                self.memory_sink = None;
                self.inner.set_trace_sink(Arc::new(NoopSink));
            }
            "memory" => {
                let session_id = session_id
                    .ok_or_else(|| PyValueError::new_err("memory sink requires session_id"))?;
                let sink = Arc::new(MemorySink::new(session_id));
                self.memory_sink = Some(sink.clone());
                self.inner.set_trace_sink(sink);
            }
            "jsonl" => {
                let session_id = session_id
                    .ok_or_else(|| PyValueError::new_err("jsonl sink requires session_id"))?;
                let path = path.ok_or_else(|| PyValueError::new_err("jsonl sink requires path"))?;
                let sink = JsonlSink::new(session_id, &path)
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

    /// Dense (semantic) skill retrieval — the skill analog of
    /// `ToolRegistry.search_dense`. Only present in dense-enabled builds.
    #[cfg(feature = "dense-search")]
    #[pyo3(signature = (query, top_k, origin=None))]
    fn search_dense(&self, query: String, top_k: u32, origin: Option<String>) -> Vec<SkillHit> {
        let parsed = match origin.as_deref() {
            Some("agent") => Origin::Agent,
            _ => Origin::Direct,
        };
        self.inner
            .search_dense_with_origin(&query, top_k as usize, parsed)
            .into_iter()
            .map(|hit| SkillHit {
                skill_id: hit.skill_id,
                score: hit.score as f64,
            })
            .collect()
    }

    fn record_event(&self, event: &Bound<'_, PyAny>) -> PyResult<()> {
        let value: Value = pythonize::depythonize(event)
            .map_err(|e| PyValueError::new_err(format!("invalid trace event: {e}")))?;
        let event: TraceEvent = serde_json::from_value(value)
            .map_err(|e| PyValueError::new_err(format!("invalid trace event: {e}")))?;
        self.inner.record_event(event);
        Ok(())
    }

    #[pyo3(signature = (kind, session_id=None, path=None))]
    fn set_trace_sink(
        &mut self,
        kind: String,
        session_id: Option<String>,
        path: Option<String>,
    ) -> PyResult<()> {
        match kind.as_str() {
            "noop" => {
                self.memory_sink = None;
                self.inner.set_trace_sink(Arc::new(NoopSink));
            }
            "memory" => {
                let session_id = session_id
                    .ok_or_else(|| PyValueError::new_err("memory sink requires session_id"))?;
                let sink = Arc::new(MemorySink::new(session_id));
                self.memory_sink = Some(sink.clone());
                self.inner.set_trace_sink(sink);
            }
            "jsonl" => {
                let session_id = session_id
                    .ok_or_else(|| PyValueError::new_err("jsonl sink requires session_id"))?;
                let path = path.ok_or_else(|| PyValueError::new_err("jsonl sink requires path"))?;
                let sink = JsonlSink::new(session_id, &path)
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
    Ok(())
}
