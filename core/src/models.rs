use serde::{Deserialize, Serialize};

// Tool fields for multi-field embeddings

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolFields {
    pub name: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_schema: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<String>,
}

#[derive(Debug, Clone)]
pub struct FieldEmbeddings {
    pub name: Vec<f32>,
    pub description: Vec<f32>,
    pub input_schema: Option<Vec<f32>>,
    pub output_schema: Option<Vec<f32>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EmbeddingFieldWeights {
    #[serde(default = "default_name_weight")]
    pub name: f32,
    #[serde(default = "default_description_weight")]
    pub description: f32,
    #[serde(default = "default_input_schema_weight")]
    pub input_schema: f32,
    #[serde(default = "default_output_schema_weight")]
    pub output_schema: f32,
}

fn default_name_weight() -> f32 { 0.1 }
fn default_description_weight() -> f32 { 0.5 }
fn default_input_schema_weight() -> f32 { 0.3 }
fn default_output_schema_weight() -> f32 { 0.1 }

impl Default for EmbeddingFieldWeights {
    fn default() -> Self {
        Self {
            name: 0.1,
            description: 0.5,
            input_schema: 0.3,
            output_schema: 0.1,
        }
    }
}

// API types

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tool {
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub parameters: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fields: Option<ToolFields>,
}

#[derive(Debug, Clone)]
pub struct StoredTool {
    pub tool: Tool,
    pub embeddings: FieldEmbeddings,
    pub bm25_text: String,
}

#[derive(Debug, Deserialize)]
pub struct RegisterToolsRequest {
    pub tools: Vec<Tool>,
}

#[derive(Debug, Serialize)]
pub struct RegisterToolsResponse {
    pub registered: usize,
}

#[derive(Debug, Serialize)]
pub struct ListToolsResponse {
    pub tools: Vec<Tool>,
}

#[derive(Debug, Deserialize)]
pub struct DiscoverRequest {
    pub query: String,
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub embedding_weights: Option<EmbeddingFieldWeights>,
    #[serde(default)]
    pub exclude: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
pub struct DiscoverResponse {
    pub tools: Vec<RankedTool>,
}

#[derive(Debug, Serialize)]
pub struct RankedTool {
    #[serde(flatten)]
    pub tool: Tool,
    pub score: f32,
}

#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub error: String,
}
