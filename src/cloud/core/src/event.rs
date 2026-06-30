use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::message::Message;

/// A single LLM-call event — the entire v1 telemetry surface (ADR-0013).
///
/// Optional fields are omitted on the wire when absent and ignored-if-unknown on
/// read, so adding fields later stays non-breaking. `provider` and `model` hold
/// **resolved** values (who actually served the request), not the requested slug.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Event {
    /// Resolved provider, e.g. `openai`, `anthropic`, `bedrock`. Free-form.
    pub provider: String,
    /// Resolved model, e.g. `gpt-5.5`.
    pub model: String,
    /// Event timestamp, RFC 3339.
    pub ts: String,
    /// Whether the response was streamed.
    #[serde(default)]
    pub stream: bool,
    /// Wall-clock latency of the call in milliseconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
    /// Top-level system prompt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    /// Tool definitions offered to the model.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<ToolDef>,
    /// The conversation sent to / returned by the model.
    pub messages: Vec<Message>,
    /// Sampling parameters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Params>,
    /// Token usage.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
    /// Why generation stopped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<FinishReason>,
}

/// A tool definition: `parameters` is a JSON Schema object.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolDef {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub parameters: Value,
}

/// Sampling parameters; every field optional.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Params {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop: Option<Vec<String>>,
}

/// Token usage, normalized across providers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_tokens: Option<u64>,
}

/// Why generation stopped, normalized across providers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FinishReason {
    Stop,
    Length,
    ToolCall,
    ContentFilter,
    Refusal,
}
