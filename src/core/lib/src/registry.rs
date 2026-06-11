use std::sync::Arc;
use std::time::Instant;

use bm25::{Document, Language, SearchEngineBuilder};

use crate::indexing::searchable_text;
use crate::tool::Tool;
use crate::trace::{
    ChurnKind, NoopSink, Origin, SearchHitTrace, SearchStage, TraceEvent, TraceSink,
};

// Tuned for short tool descriptions; see ADR-0004.
const BM25_K1: f32 = 0.9;
const BM25_B: f32 = 0.4;

pub struct SearchHit {
    pub tool_id: String,
    pub score: f32,
}

pub struct ToolRegistry {
    tools: Vec<Tool>,
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
            sink: Arc::new(NoopSink),
        }
    }

    pub fn with_trace_sink(sink: Arc<dyn TraceSink>) -> Self {
        Self {
            tools: Vec::new(),
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
        self.tools.push(tool);
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
        let hits: Vec<SearchHit> = if self.tools.is_empty() {
            Vec::new()
        } else {
            let docs = self.tools.iter().map(|t| Document {
                id: t.id.clone(),
                contents: searchable_text(t),
            });
            let engine = SearchEngineBuilder::<String>::with_documents(Language::English, docs)
                .k1(BM25_K1)
                .b(BM25_B)
                .build();
            // The bm25 crate sorts by score only and collects candidates through
            // a HashSet, so equal scores fall back to hash-seed iteration order
            // and flip between processes: tied hits at the top_k boundary make
            // top-K membership nondeterministic. Rank the full match set, break
            // ties by tool_id, then cut.
            let mut ranked: Vec<SearchHit> = engine
                .search(query, self.tools.len())
                .into_iter()
                .map(|r| SearchHit {
                    tool_id: r.document.id,
                    score: r.score,
                })
                .collect();
            ranked.sort_by(|a, b| {
                b.score
                    .partial_cmp(&a.score)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| a.tool_id.cmp(&b.tool_id))
            });
            ranked.truncate(top_k);
            ranked
        };
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
}
