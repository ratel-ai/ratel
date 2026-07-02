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

/// A traced search: the ranked hits plus the `search_id` stamped on the
/// emitted `search` event.
pub struct SearchOutcome {
    pub search_id: String,
    pub hits: Vec<SearchHit>,
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
        self.search_traced(query, top_k, origin).hits
    }

    /// Like [`Self::search_with_origin`], but also returns the `search_id`
    /// stamped on the emitted `search` event, so callers can attribute later
    /// invokes to this search (ADR-0013).
    pub fn search_traced(&self, query: &str, top_k: usize, origin: Origin) -> SearchOutcome {
        let search_id = uuid::Uuid::new_v4().to_string();
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
            search_id: Some(search_id.clone()),
        });
        SearchOutcome { search_id, hits }
    }
}
