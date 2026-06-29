use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use crate::dense_search::dense_search;
use crate::embedding::embedder;
use crate::fusion::{RETRIEVE_DEPTH, RRF_K, rrf_fuse};
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
    /// Precomputed dense embeddings, index-aligned with `tools` (one per
    /// `register`). Computed once at registration since the indexed text never
    /// changes; queries embed only the query string. See ADR-0013.
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
        // Embed the same flattened text BM25 indexes (ADR-0004 contract), once,
        // before the tool is moved into the corpus. Index-aligned with `tools`.
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

    /// Hybrid retrieval (ADR-0013, ADR-0014): BM25 and dense each rank the
    /// corpus and RRF fuses the two rankings into the final order. The public
    /// `(query, top_k) -> Vec<SearchHit>` contract is unchanged — callers
    /// upgrading from the BM25-only releases need no code change; the returned
    /// `score` is the RRF fusion score.
    pub fn search_with_origin(&self, query: &str, top_k: usize, origin: Origin) -> Vec<SearchHit> {
        let started = Instant::now();
        // Empty corpus (or a zero budget) short-circuits before any model load.
        if self.tools.is_empty() || top_k == 0 {
            self.sink.record(TraceEvent::Search {
                query: query.to_string(),
                origin,
                top_k: top_k as u32,
                hits: Vec::new(),
                stages: Vec::new(),
                took_ms: started.elapsed().as_millis() as u64,
            });
            return Vec::new();
        }

        // Retrieve deeper than `top_k` so the two arms have rank signal to fuse;
        // a tool ranked low by one arm but high by the other can still surface.
        let depth = RETRIEVE_DEPTH.max(top_k);

        // Collapse duplicate ids to the latest embedding — mirrors the BM25
        // engine's id-keyed last-wins, so re-registering a tool replaces it here.
        let mut latest_vec: HashMap<&str, &[f32]> = HashMap::new();
        for (tool, embedding) in self.tools.iter().zip(self.embeddings.iter()) {
            latest_vec.insert(tool.id.as_str(), embedding.as_slice());
        }

        // 1. BM25 (lexical).
        let t = Instant::now();
        let bm25_ranked = bm25_search(
            self.tools
                .iter()
                .map(|t| (t.id.clone(), searchable_text(t))),
            query,
            depth,
        );
        let bm25_stage = SearchStage {
            name: "bm25".into(),
            took_ms: t.elapsed().as_millis() as u64,
            top_score: bm25_ranked.first().map(|(_, s)| *s as f64),
        };

        // 2. Dense (semantic).
        let t = Instant::now();
        let query_vec = embedder().embed_query(query);
        let dense_ranked = dense_search(
            latest_vec.iter().map(|(id, v)| (id.to_string(), *v)),
            &query_vec,
            depth,
        );
        let dense_stage = SearchStage {
            name: "dense".into(),
            took_ms: t.elapsed().as_millis() as u64,
            top_score: dense_ranked.first().map(|(_, s)| *s as f64),
        };

        // 3. RRF fusion of the two rankings → final top_k.
        let t = Instant::now();
        let bm25_ids: Vec<String> = bm25_ranked.into_iter().map(|(id, _)| id).collect();
        let dense_ids: Vec<String> = dense_ranked.into_iter().map(|(id, _)| id).collect();
        let mut fused = rrf_fuse(&[&bm25_ids, &dense_ids], RRF_K);
        fused.truncate(top_k);
        let rrf_stage = SearchStage {
            name: "rrf".into(),
            took_ms: t.elapsed().as_millis() as u64,
            top_score: fused.first().map(|(_, s)| *s as f64),
        };

        let hits: Vec<SearchHit> = fused
            .into_iter()
            .map(|(tool_id, score)| SearchHit { tool_id, score })
            .collect();
        let took_ms = started.elapsed().as_millis() as u64;
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
            stages: vec![bm25_stage, dense_stage, rrf_stage],
            took_ms,
        });
        hits
    }
}
