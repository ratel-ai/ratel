use bm25::{Document, Language, SearchEngineBuilder};

use crate::indexing::searchable_text;
use crate::tool::Tool;

// Tuned for short tool descriptions; see ADR-0004.
const BM25_K1: f32 = 0.9;
const BM25_B: f32 = 0.4;

pub struct SearchHit {
    pub tool_id: String,
    pub score: f32,
}

#[derive(Default)]
pub struct ToolRegistry {
    tools: Vec<Tool>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, tool: Tool) {
        self.tools.push(tool);
    }

    pub fn search(&self, query: &str, top_k: usize) -> Vec<SearchHit> {
        if self.tools.is_empty() {
            return Vec::new();
        }
        let docs = self.tools.iter().map(|t| Document {
            id: t.id.clone(),
            contents: searchable_text(t),
        });
        let engine = SearchEngineBuilder::<String>::with_documents(Language::English, docs)
            .k1(BM25_K1)
            .b(BM25_B)
            .build();
        engine
            .search(query, top_k)
            .into_iter()
            .map(|r| SearchHit {
                tool_id: r.document.id,
                score: r.score,
            })
            .collect()
    }
}
