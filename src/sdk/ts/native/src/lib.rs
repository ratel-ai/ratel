#![deny(clippy::all)]

#[macro_use]
extern crate napi_derive;

use ratel_ai_core as core;
use serde_json::Value;

#[napi(object)]
pub struct Tool {
    pub id: String,
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    pub output_schema: Value,
}

#[napi(object)]
pub struct SearchHit {
    pub tool_id: String,
    pub score: f64,
}

#[napi]
pub struct ToolRegistry {
    inner: core::ToolRegistry,
}

#[napi]
impl ToolRegistry {
    #[napi(constructor)]
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        Self {
            inner: core::ToolRegistry::new(),
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
}
