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

#[derive(Debug, Clone, Serialize, Deserialize)]
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

// Recall types

fn default_recall_limit() -> usize { 5 }

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RecallToolsConfig {
    #[serde(default = "default_recall_limit")]
    pub limit: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_similarity: Option<f32>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(untagged)]
pub enum RecallToolsOption {
    Bool(bool),
    Config(RecallToolsConfig),
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct RecallConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<RecallToolsOption>,
}

// Context types

#[derive(Debug, Deserialize)]
pub struct ContextMessagesConfig {
    #[serde(default = "default_context_strategy")]
    pub strategy: String,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: usize,
    #[serde(default)]
    pub keep_first: bool,
}

fn default_context_strategy() -> String { "recent".into() }
fn default_max_tokens() -> usize { 4000 }

impl Default for ContextMessagesConfig {
    fn default() -> Self {
        Self {
            strategy: default_context_strategy(),
            max_tokens: default_max_tokens(),
            keep_first: false,
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
    #[serde(default)]
    pub recall: Option<RecallConfig>,
    #[serde(default)]
    pub limit_tokens: Option<usize>,
}

#[derive(Debug, Serialize)]
pub struct RecalledContext {
    pub tools: Vec<RankedTool>,
    pub memories: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SummaryRange {
    pub first_seq: i64,
    pub last_seq: i64,
    pub count: usize,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary_range: Option<SummaryRange>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recall_tools_option_deserializes_from_bool_true() {
        let json = r#"{"tools": true}"#;
        let config: RecallConfig = serde_json::from_str(json).unwrap();
        match config.tools {
            Some(RecallToolsOption::Bool(true)) => {}
            other => panic!("expected Bool(true), got {other:?}"),
        }
    }

    #[test]
    fn recall_tools_option_deserializes_from_config_object() {
        let json = r#"{"tools": {"limit": 3, "min_similarity": 0.5}}"#;
        let config: RecallConfig = serde_json::from_str(json).unwrap();
        match config.tools {
            Some(RecallToolsOption::Config(c)) => {
                assert_eq!(c.limit, 3);
                assert_eq!(c.min_similarity, Some(0.5));
            }
            other => panic!("expected Config, got {other:?}"),
        }
    }

    #[test]
    fn recall_config_defaults_to_none_when_absent() {
        let json = r#"{}"#;
        let config: RecallConfig = serde_json::from_str(json).unwrap();
        assert!(config.tools.is_none());
    }

    #[test]
    fn context_request_accepts_recall_and_limit_tokens() {
        let json = r#"{
            "dataset": "ds",
            "namespace": "ns",
            "session": "s1",
            "recall": {"tools": true},
            "limit_tokens": 8000
        }"#;
        let req: ContextRequest = serde_json::from_str(json).unwrap();
        assert!(req.recall.is_some());
        assert_eq!(req.limit_tokens, Some(8000));
    }

    #[test]
    fn context_request_recall_and_limit_tokens_default_to_none() {
        let json = r#"{
            "dataset": "ds",
            "namespace": "ns",
            "session": "s1"
        }"#;
        let req: ContextRequest = serde_json::from_str(json).unwrap();
        assert!(req.recall.is_none());
        assert!(req.limit_tokens.is_none());
    }

    #[test]
    fn recall_tools_config_uses_default_limit() {
        let json = r#"{"tools": {}}"#;
        let config: RecallConfig = serde_json::from_str(json).unwrap();
        match config.tools {
            Some(RecallToolsOption::Config(c)) => {
                assert_eq!(c.limit, 5);
                assert!(c.min_similarity.is_none());
            }
            other => panic!("expected Config with defaults, got {other:?}"),
        }
    }
}
