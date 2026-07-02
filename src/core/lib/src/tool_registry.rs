use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use crate::dense_search::dense_search;
use crate::embedding::{Embedder, EmbedderError, embedder_with_telemetry};
use crate::indexing::searchable_text;
use crate::tool::Tool;
use crate::trace::{
    ChurnKind, NoopSink, Origin, SearchHitTrace, SearchStage, TraceEvent, TraceSink,
};

pub struct SearchHit {
    pub tool_id: String,
    pub score: f32,
}

pub struct ToolRegistry {
    tools: Vec<Tool>,
    /// Precomputed embeddings, index-aligned with `tools` (one per `register`).
    /// Computed once at registration since the indexed text never changes.
    embeddings: Vec<Vec<f32>>,
    sink: Arc<dyn TraceSink>,
    /// Test-only override for the process embedder (`None` → the shared
    /// bge-small, loaded lazily on first use). Lets tests inject a
    /// deterministic/failing embedder without touching the network.
    embedder_override: Option<Arc<dyn Embedder>>,
}

impl Default for ToolRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self {
            tools: Vec::new(),
            embeddings: Vec::new(),
            sink: Arc::new(NoopSink),
            embedder_override: None,
        }
    }

    pub fn with_trace_sink(sink: Arc<dyn TraceSink>) -> Self {
        Self {
            tools: Vec::new(),
            embeddings: Vec::new(),
            sink,
            embedder_override: None,
        }
    }

    pub fn set_trace_sink(&mut self, sink: Arc<dyn TraceSink>) {
        self.sink = sink;
    }

    pub fn record_event(&self, event: TraceEvent) {
        self.sink.record(event);
    }

    /// The embedder to use: an injected one (tests) or the shared process
    /// embedder, whose one-time load telemetry is recorded on this sink.
    fn resolve_embedder(&self) -> Result<Arc<dyn Embedder>, EmbedderError> {
        match &self.embedder_override {
            Some(e) => Ok(e.clone()),
            None => embedder_with_telemetry(self.sink.as_ref()),
        }
    }

    /// Register a tool. Fallible: embedding needs the model, whose first-use load
    /// can fail (network/cache/underpowered machine) — surfaced as a catchable
    /// [`EmbedderError`] instead of aborting the process.
    pub fn register(&mut self, tool: Tool) -> Result<(), EmbedderError> {
        let tool_id = tool.id.clone();
        // Embed the flattened tool text once, before the tool is moved into the
        // corpus. Index-aligned with `tools`; the indexed text never changes.
        let embedding = self
            .resolve_embedder()?
            .embed_doc(&searchable_text(&tool))?;
        self.tools.push(tool);
        self.embeddings.push(embedding);
        self.sink.record(TraceEvent::IndexChurn {
            kind: ChurnKind::Add,
            tool_id,
        });
        Ok(())
    }

    pub fn search(&self, query: &str, top_k: usize) -> Result<Vec<SearchHit>, EmbedderError> {
        self.search_with_origin(query, top_k, Origin::Direct)
    }

    /// Dense (semantic) retrieval: embed the query and cosine-rank it against the
    /// precomputed tool embeddings. This is *the* retrieval path in this version
    /// (see ADR-0013); the lexical baseline lives in an earlier version. Fallible
    /// for the same reason as [`Self::register`].
    pub fn search_with_origin(
        &self,
        query: &str,
        top_k: usize,
        origin: Origin,
    ) -> Result<Vec<SearchHit>, EmbedderError> {
        let started = Instant::now();
        let query_vec = self.resolve_embedder()?.embed_query(query)?;
        // Collapse duplicate ids to the latest embedding (last-wins), so
        // re-registering a tool replaces it — see the re-register test.
        let mut latest: HashMap<&str, &[f32]> = HashMap::new();
        for (tool, embedding) in self.tools.iter().zip(self.embeddings.iter()) {
            latest.insert(tool.id.as_str(), embedding.as_slice());
        }
        let hits: Vec<SearchHit> = dense_search(
            latest.into_iter().map(|(id, v)| (id.to_string(), v)),
            &query_vec,
            top_k,
        )
        .into_iter()
        .map(|(tool_id, score)| SearchHit { tool_id, score })
        .collect();
        let took_ms = started.elapsed().as_millis() as u64;
        let top_score = hits.first().map(|h| h.score as f64);
        self.sink.record(TraceEvent::Search {
            query: query.to_string(),
            origin,
            top_k: top_k as u32,
            hits: hits
                .iter()
                .map(|h| SearchHitTrace {
                    tool_id: h.tool_id.clone(),
                    score: h.score as f64,
                })
                .collect(),
            stages: vec![SearchStage {
                name: "dense".into(),
                took_ms,
                top_score,
            }],
            took_ms,
        });
        Ok(hits)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trace::MemorySink;

    /// Deterministic, network-free embedder: a 3-d one-hot keyed on a keyword so
    /// ranking is predictable ("read" docs/queries collide, etc.).
    struct StubEmbedder;
    impl StubEmbedder {
        fn vec_for(text: &str) -> Vec<f32> {
            let t = text.to_lowercase();
            if t.contains("read") {
                vec![1.0, 0.0, 0.0]
            } else if t.contains("delete") || t.contains("remove") {
                vec![0.0, 1.0, 0.0]
            } else {
                vec![0.0, 0.0, 1.0]
            }
        }
    }
    impl Embedder for StubEmbedder {
        fn embed_doc(&self, text: &str) -> Result<Vec<f32>, EmbedderError> {
            Ok(StubEmbedder::vec_for(text))
        }
        fn embed_query(&self, text: &str) -> Result<Vec<f32>, EmbedderError> {
            Ok(StubEmbedder::vec_for(text))
        }
    }

    /// Stands in for a machine that can't run the model: every embed fails.
    struct FailingEmbedder;
    impl Embedder for FailingEmbedder {
        fn embed_doc(&self, _: &str) -> Result<Vec<f32>, EmbedderError> {
            Err(EmbedderError::Inference {
                source: "stub failure".into(),
            })
        }
        fn embed_query(&self, _: &str) -> Result<Vec<f32>, EmbedderError> {
            Err(EmbedderError::Inference {
                source: "stub failure".into(),
            })
        }
    }

    fn with_embedder(embedder: Arc<dyn Embedder>) -> ToolRegistry {
        ToolRegistry {
            tools: Vec::new(),
            embeddings: Vec::new(),
            sink: Arc::new(NoopSink),
            embedder_override: Some(embedder),
        }
    }

    fn tool(id: &str, description: &str) -> Tool {
        Tool {
            id: id.into(),
            name: id.into(),
            description: description.into(),
            input_schema: serde_json::json!({}),
            output_schema: serde_json::json!({}),
        }
    }

    #[test]
    fn register_and_search_rank_with_injected_embedder() {
        let mut reg = with_embedder(Arc::new(StubEmbedder));
        reg.register(tool("read_file", "read a file")).unwrap();
        reg.register(tool("delete_file", "delete a file")).unwrap();
        let hits = reg.search("read something", 5).unwrap();
        assert_eq!(hits.first().map(|h| h.tool_id.as_str()), Some("read_file"));
    }

    #[test]
    fn register_surfaces_embedder_error_instead_of_panicking() {
        let mut reg = with_embedder(Arc::new(FailingEmbedder));
        let err = reg.register(tool("t", "x")).unwrap_err();
        assert!(matches!(err, EmbedderError::Inference { .. }));
    }

    #[test]
    fn search_surfaces_embedder_error_instead_of_panicking() {
        let reg = with_embedder(Arc::new(FailingEmbedder));
        assert!(matches!(
            reg.search("anything", 5),
            Err(EmbedderError::Inference { .. })
        ));
    }

    #[test]
    fn register_and_search_emit_trace_events() {
        let mut reg = with_embedder(Arc::new(StubEmbedder));
        let sink = Arc::new(MemorySink::new("test-session"));
        reg.set_trace_sink(sink.clone());
        reg.register(tool("read_file", "read a file")).unwrap();
        reg.search_with_origin("read", 5, Origin::Agent).unwrap();

        let events = sink.drain();
        assert!(events.iter().any(|e| matches!(
            e.event,
            TraceEvent::IndexChurn {
                kind: ChurnKind::Add,
                ..
            }
        )));
        assert!(events.iter().any(|e| matches!(
            &e.event,
            TraceEvent::Search { origin: Origin::Agent, hits, .. } if !hits.is_empty()
        )));
    }
}
