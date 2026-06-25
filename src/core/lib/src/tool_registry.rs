use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use crate::dense_search::dense_search;
use crate::embedding::embedder;
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
        }
    }

    pub fn with_trace_sink(sink: Arc<dyn TraceSink>) -> Self {
        Self {
            tools: Vec::new(),
            embeddings: Vec::new(),
            sink,
        }
    }

    pub fn set_trace_sink(&mut self, sink: Arc<dyn TraceSink>) {
        self.sink = sink;
    }

    pub fn record_event(&self, event: TraceEvent) {
        self.sink.record(event);
    }

    pub fn register(&mut self, tool: Tool) {
        let tool_id = tool.id.clone();
        // Embed the flattened tool text once, before the tool is moved into the
        // corpus. Index-aligned with `tools`; the indexed text never changes.
        let embedding = embedder().embed_doc(&searchable_text(&tool));
        self.tools.push(tool);
        self.embeddings.push(embedding);
        self.sink.record(TraceEvent::IndexChurn {
            kind: ChurnKind::Add,
            tool_id,
        });
    }

    pub fn search(&self, query: &str, top_k: usize) -> Vec<SearchHit> {
        self.search_with_origin(query, top_k, Origin::Direct)
    }

    /// Dense (semantic) retrieval: embed the query and cosine-rank it against the
    /// precomputed tool embeddings. This is *the* retrieval path in this version
    /// (see ADR-0013); the lexical baseline lives in an earlier version.
    pub fn search_with_origin(&self, query: &str, top_k: usize, origin: Origin) -> Vec<SearchHit> {
        let started = Instant::now();
        let query_vec = embedder().embed_query(query);
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
        hits
    }
}
