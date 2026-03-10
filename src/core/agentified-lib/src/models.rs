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
    #[serde(default)]
    pub turn_id: Option<String>,
}

// Session/turn tracking

#[derive(Debug, Clone)]
pub struct Turn {
    pub tools_loaded: Vec<String>,
    pub message: String,
}

#[derive(Debug, Deserialize)]
pub struct CaptureTurnRequest {
    pub tools_loaded: Vec<String>,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct CaptureTurnResponse {
    pub turn_id: String,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub graph_expanded: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub error: String,
}

// Message types

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageInput {
    pub role: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<serde_json::Value>,
    pub created_at: String,
    pub seq: i64,
}

#[derive(Debug, Deserialize)]
pub struct AppendMessagesRequest {
    pub dataset: String,
    pub namespace: String,
    pub session: String,
    pub messages: Vec<MessageInput>,
}

#[derive(Debug, Serialize)]
pub struct AppendMessagesResponse {
    pub appended: usize,
    pub first_seq: i64,
    pub last_seq: i64,
}

#[derive(Debug, Deserialize)]
pub struct GetMessagesQuery {
    pub dataset: String,
    pub namespace: String,
    pub session: String,
    #[serde(default = "default_limit")]
    pub limit: i64,
    #[serde(default)]
    pub after_seq: Option<i64>,
    #[serde(default)]
    pub around_seq: Option<i64>,
}

fn default_limit() -> i64 { 50 }

#[derive(Debug, Serialize)]
pub struct GetMessagesResponse {
    pub messages: Vec<StoredMessage>,
    pub has_more: bool,
    pub max_seq: i64,
}

// Context types

#[derive(Debug, Deserialize)]
pub struct ContextMessagesConfig {
    #[serde(default = "default_context_strategy")]
    pub strategy: String,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: usize,
}

fn default_context_strategy() -> String { "recent".into() }
fn default_max_tokens() -> usize { 4000 }

impl Default for ContextMessagesConfig {
    fn default() -> Self {
        Self {
            strategy: default_context_strategy(),
            max_tokens: default_max_tokens(),
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct ContextRequest {
    pub dataset: String,
    pub namespace: String,
    pub session: String,
    #[serde(default)]
    pub messages: ContextMessagesConfig,
}

#[derive(Debug, Serialize)]
pub struct RecalledContext {
    pub tools: Vec<serde_json::Value>,
    pub memories: Vec<serde_json::Value>,
}

#[derive(Debug, Serialize)]
pub struct ContextResponse {
    pub messages: Vec<StoredMessage>,
    pub strategy_used: String,
    pub total_messages: i64,
    pub included_messages: usize,
    pub recalled: RecalledContext,
    pub token_estimate: usize,
    pub conversation_messages: usize,
    pub fallback: bool,
}
