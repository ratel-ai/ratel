use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A typed piece of message content. The block model is the richest superset of
/// the provider surfaces (Anthropic / Vercel AI SDK); OpenAI parts map 1:1.
///
/// New variants are additive; renames or removals are breaking — see ADR-0013.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Block {
    /// Plain text.
    Text { text: String },
    /// An assistant tool call. `arguments` is a **parsed object**, never a
    /// JSON-encoded string — the OpenAI string is parsed once at the edge.
    ToolCall {
        id: String,
        name: String,
        arguments: Value,
    },
    /// An image, supplied inline (`source`, e.g. base64) or by `url`.
    Image {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        url: Option<String>,
        media_type: String,
    },
    /// A non-image file, supplied inline (`source`) or by `url`.
    File {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        url: Option<String>,
        media_type: String,
    },
}
