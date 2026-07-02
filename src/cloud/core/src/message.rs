use serde::{Deserialize, Serialize};

use crate::content::Block;

/// One turn in the conversation. Tagged on `role` so an invalid role/shape
/// combination is unrepresentable: only a `tool` message carries a
/// `tool_call_id`, and its content is always a plain string.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "snake_case")]
pub enum Message {
    User {
        content: Content,
    },
    Assistant {
        content: Content,
    },
    Tool {
        tool_call_id: String,
        content: String,
    },
}

/// Message content: either a bare string or an ordered list of typed blocks.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Content {
    Text(String),
    Blocks(Vec<Block>),
}
