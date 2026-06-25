use std::sync::Arc;
use std::time::Instant;

use crate::indexing::searchable_text;
use crate::search::bm25_search;
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
    #[cfg(feature = "dense-search")]
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
            #[cfg(feature = "dense-search")]
            embeddings: Vec::new(),
            sink: Arc::new(NoopSink),
        }
    }

    pub fn with_trace_sink(sink: Arc<dyn TraceSink>) -> Self {
        Self {
            tools: Vec::new(),
            #[cfg(feature = "dense-search")]
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
        // Embed the same flattened text BM25 indexes (ADR-0004 contract), once,
        // before the tool is moved into the corpus. Index-aligned with `tools`.
        #[cfg(feature = "dense-search")]
        let embedding = crate::embedding::embedder().embed_doc(&searchable_text(&tool));
        self.tools.push(tool);
        #[cfg(feature = "dense-search")]
        self.embeddings.push(embedding);
        self.sink.record(TraceEvent::IndexChurn {
            kind: ChurnKind::Add,
            tool_id,
        });
    }

    pub fn search(&self, query: &str, top_k: usize) -> Vec<SearchHit> {
        self.search_with_origin(query, top_k, Origin::Direct)
    }

    pub fn search_with_origin(&self, query: &str, top_k: usize, origin: Origin) -> Vec<SearchHit> {
        let started = Instant::now();
        let hits: Vec<SearchHit> = bm25_search(
            self.tools
                .iter()
                .map(|t| (t.id.clone(), searchable_text(t))),
            query,
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
                name: "bm25".into(),
                took_ms,
                top_score,
            }],
            took_ms,
        });
        hits
    }

    /// Dense (semantic) retrieval: embed the query and cosine-rank it against the
    /// precomputed tool embeddings. Same `(query, top_k) -> Vec<SearchHit>`
    /// contract as [`Self::search`], so it slots into the benchmark unchanged.
    /// BM25 is untouched; this is an additive path (see ADR-0013).
    #[cfg(feature = "dense-search")]
    pub fn search_dense(&self, query: &str, top_k: usize) -> Vec<SearchHit> {
        self.search_dense_with_origin(query, top_k, Origin::Direct)
    }

    #[cfg(feature = "dense-search")]
    pub fn search_dense_with_origin(
        &self,
        query: &str,
        top_k: usize,
        origin: Origin,
    ) -> Vec<SearchHit> {
        use std::collections::HashMap;

        let started = Instant::now();
        let query_vec = crate::embedding::embedder().embed_query(query);
        // Collapse duplicate ids to the latest embedding — mirrors the BM25
        // engine's id-keyed last-wins, so re-registering a tool replaces it here
        // too (see `re_registering_same_id_replaces_entry`).
        let mut latest: HashMap<&str, &[f32]> = HashMap::new();
        for (tool, embedding) in self.tools.iter().zip(self.embeddings.iter()) {
            latest.insert(tool.id.as_str(), embedding.as_slice());
        }
        let hits: Vec<SearchHit> = crate::dense_search::dense_search(
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
