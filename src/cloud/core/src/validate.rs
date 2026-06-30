use crate::content::Block;
use crate::event::Event;
use crate::message::{Content, Message};

/// One validation failure: a JSON-ish `path` into the event and a `message`.
/// Mirrors the ingest endpoint's `{ path, message }` issue shape.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Issue {
    pub path: String,
    pub message: String,
}

/// The set of invariants an [`Event`] violated. Non-empty by construction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationError {
    pub issues: Vec<Issue>,
}

impl std::fmt::Display for ValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "invalid event ({} issue(s))", self.issues.len())?;
        for issue in &self.issues {
            write!(f, "\n  {}: {}", issue.path, issue.message)?;
        }
        Ok(())
    }
}

impl std::error::Error for ValidationError {}

/// Check the semantic invariants the type system can't express. Serde already
/// guarantees the structural shape; this catches empties, misplaced tool calls,
/// and non-object JSON-Schema/arguments payloads.
pub fn validate(event: &Event) -> Result<(), ValidationError> {
    let mut issues = Vec::new();

    if event.provider.trim().is_empty() {
        issues.push(issue("provider", "must not be empty"));
    }
    if event.model.trim().is_empty() {
        issues.push(issue("model", "must not be empty"));
    }
    if event.ts.trim().is_empty() {
        issues.push(issue("ts", "must not be empty"));
    }
    if event.messages.is_empty() {
        issues.push(issue("messages", "must not be empty"));
    }

    for (i, tool) in event.tools.iter().enumerate() {
        if tool.name.trim().is_empty() {
            issues.push(issue(&format!("tools[{i}].name"), "must not be empty"));
        }
        if !tool.parameters.is_object() {
            issues.push(issue(
                &format!("tools[{i}].parameters"),
                "must be a JSON Schema object",
            ));
        }
    }

    for (i, message) in event.messages.iter().enumerate() {
        match message {
            Message::User { content } => {
                validate_content(content, false, &format!("messages[{i}]"), &mut issues);
            }
            Message::Assistant { content } => {
                validate_content(content, true, &format!("messages[{i}]"), &mut issues);
            }
            Message::Tool { tool_call_id, .. } => {
                if tool_call_id.trim().is_empty() {
                    issues.push(issue(
                        &format!("messages[{i}].tool_call_id"),
                        "must not be empty",
                    ));
                }
            }
        }
    }

    if issues.is_empty() {
        Ok(())
    } else {
        Err(ValidationError { issues })
    }
}

fn validate_content(content: &Content, allow_tool_call: bool, base: &str, issues: &mut Vec<Issue>) {
    let Content::Blocks(blocks) = content else {
        return;
    };
    for (j, block) in blocks.iter().enumerate() {
        let path = format!("{base}.content[{j}]");
        match block {
            Block::ToolCall { arguments, .. } => {
                if !allow_tool_call {
                    issues.push(issue(
                        &path,
                        "tool_call blocks are only allowed in assistant messages",
                    ));
                }
                if !arguments.is_object() {
                    issues.push(issue(
                        &format!("{path}.arguments"),
                        "must be a parsed object",
                    ));
                }
            }
            Block::Image {
                source,
                url,
                media_type,
            }
            | Block::File {
                source,
                url,
                media_type,
            } => {
                if source.is_some() == url.is_some() {
                    issues.push(issue(&path, "exactly one of `source` or `url` must be set"));
                }
                if media_type.trim().is_empty() {
                    issues.push(issue(&format!("{path}.media_type"), "must not be empty"));
                }
            }
            Block::Text { .. } => {}
        }
    }
}

fn issue(path: &str, message: &str) -> Issue {
    Issue {
        path: path.to_string(),
        message: message.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::content::Block;
    use crate::event::Event;
    use crate::message::{Content, Message};
    use serde_json::json;

    fn minimal() -> Event {
        Event {
            provider: "openai".into(),
            model: "gpt-5.5".into(),
            ts: "2026-06-30T12:00:00Z".into(),
            stream: false,
            latency_ms: None,
            system: None,
            tools: Vec::new(),
            messages: vec![Message::User {
                content: Content::Text("hi".into()),
            }],
            params: None,
            usage: None,
            finish_reason: None,
        }
    }

    fn paths(err: &ValidationError) -> Vec<&str> {
        err.issues.iter().map(|i| i.path.as_str()).collect()
    }

    #[test]
    fn minimal_event_is_valid() {
        assert!(validate(&minimal()).is_ok());
    }

    #[test]
    fn empty_provider_and_model_and_ts_are_rejected() {
        let mut e = minimal();
        e.provider = "".into();
        e.model = "  ".into();
        e.ts = "".into();
        let err = validate(&e).unwrap_err();
        let p = paths(&err);
        assert!(p.contains(&"provider"));
        assert!(p.contains(&"model"));
        assert!(p.contains(&"ts"));
    }

    #[test]
    fn empty_messages_are_rejected() {
        let mut e = minimal();
        e.messages.clear();
        let err = validate(&e).unwrap_err();
        assert_eq!(paths(&err), vec!["messages"]);
    }

    #[test]
    fn tool_call_in_user_message_is_rejected() {
        let mut e = minimal();
        e.messages = vec![Message::User {
            content: Content::Blocks(vec![Block::ToolCall {
                id: "c1".into(),
                name: "get_weather".into(),
                arguments: json!({ "location": "Paris" }),
            }]),
        }];
        let err = validate(&e).unwrap_err();
        assert_eq!(paths(&err), vec!["messages[0].content[0]"]);
    }

    #[test]
    fn tool_call_in_assistant_message_is_allowed() {
        let mut e = minimal();
        e.messages = vec![Message::Assistant {
            content: Content::Blocks(vec![Block::ToolCall {
                id: "c1".into(),
                name: "get_weather".into(),
                arguments: json!({ "location": "Paris" }),
            }]),
        }];
        assert!(validate(&e).is_ok());
    }

    #[test]
    fn non_object_tool_arguments_are_rejected() {
        let mut e = minimal();
        e.messages = vec![Message::Assistant {
            content: Content::Blocks(vec![Block::ToolCall {
                id: "c1".into(),
                name: "x".into(),
                arguments: json!("not-an-object"),
            }]),
        }];
        let err = validate(&e).unwrap_err();
        assert_eq!(paths(&err), vec!["messages[0].content[0].arguments"]);
    }

    #[test]
    fn image_needs_exactly_one_source() {
        let mut e = minimal();
        e.messages = vec![Message::User {
            content: Content::Blocks(vec![Block::Image {
                source: Some("b64".into()),
                url: Some("https://x".into()),
                media_type: "image/png".into(),
            }]),
        }];
        let err = validate(&e).unwrap_err();
        assert_eq!(paths(&err), vec!["messages[0].content[0]"]);
    }
}
