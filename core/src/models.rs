use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tool {
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub parameters: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone)]
pub struct StoredTool {
    pub tool: Tool,
    pub embedding: Vec<f32>,
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
