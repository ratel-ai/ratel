use crate::content::Block;
use crate::event::{Event, Usage};
use crate::message::{Content, Message};

/// Ingest bounds, mirrored from the cloud consumer's schema (`cloud-schema.ts`) so an
/// event that passes client validation is one the ingest endpoint accepts. These are
/// abuse/`int4` limits, not semantic maxima — generous relative to any realistic call.
const MAX_INT4: u64 = 2_147_483_647; // Postgres `integer` upper bound
const MAX_TEXT: usize = 2_000_000; // a single text / system / tool string (~2 MB)
const MAX_BLOB: usize = 20_000_000; // base64 image/file `source` (~15 MB binary)
const MAX_NAME: usize = 1_024; // identifiers: provider, model, ts, names, ids, media_type
const MAX_URL: usize = 8_192; // image/file `url`
const MAX_BLOCKS: usize = 20_000; // content blocks per message
const MAX_MESSAGES: usize = 10_000; // messages per event
const MAX_TOOLS: usize = 2_000; // tool defs per event
const MAX_STOP: usize = 100; // stop sequences per request

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
/// guarantees the structural shape (roles, block types, finish reason, numeric
/// types); this catches empties, misplaced tool calls, non-object JSON-Schema /
/// arguments payloads, and the ingest size/count bounds.
pub fn validate(event: &Event) -> Result<(), ValidationError> {
    let mut issues = Vec::new();

    check_name(&event.provider, "provider", &mut issues);
    check_name(&event.model, "model", &mut issues);
    // `ts` is only checked non-empty (and bounded): the consumer tolerates any string
    // and falls back to receipt time, so a strict RFC-3339 check here would reject
    // events the endpoint accepts.
    check_name(&event.ts, "ts", &mut issues);

    if event.messages.is_empty() {
        issues.push(issue("messages", "must not be empty"));
    }
    if event.messages.len() > MAX_MESSAGES {
        issues.push(issue("messages", "too many messages"));
    }
    if event.tools.len() > MAX_TOOLS {
        issues.push(issue("tools", "too many tools"));
    }

    for (i, tool) in event.tools.iter().enumerate() {
        let base = format!("tools[{i}]");
        check_name(&tool.name, &format!("{base}.name"), &mut issues);
        if let Some(desc) = &tool.description {
            check_len(desc, MAX_TEXT, &format!("{base}.description"), &mut issues);
        }
        if !tool.parameters.is_object() {
            issues.push(issue(
                &format!("{base}.parameters"),
                "must be a JSON Schema object",
            ));
        }
    }

    for (i, message) in event.messages.iter().enumerate() {
        let base = format!("messages[{i}]");
        match message {
            Message::User { content } => validate_content(content, false, &base, &mut issues),
            Message::Assistant { content } => validate_content(content, true, &base, &mut issues),
            Message::Tool {
                tool_call_id,
                content,
            } => {
                check_name(tool_call_id, &format!("{base}.tool_call_id"), &mut issues);
                check_len(content, MAX_TEXT, &format!("{base}.content"), &mut issues);
            }
        }
    }

    if let Some(usage) = &event.usage {
        validate_usage(usage, &mut issues);
    }
    if event.latency_ms.is_some_and(|latency| latency > MAX_INT4) {
        issues.push(issue("latency_ms", "exceeds maximum"));
    }
    if let Some(stop) = event.params.as_ref().and_then(|p| p.stop.as_ref()) {
        if stop.len() > MAX_STOP {
            issues.push(issue("params.stop", "too many stop sequences"));
        }
        for (i, s) in stop.iter().enumerate() {
            check_len(s, MAX_NAME, &format!("params.stop[{i}]"), &mut issues);
        }
    }

    if issues.is_empty() {
        Ok(())
    } else {
        Err(ValidationError { issues })
    }
}

fn validate_content(content: &Content, allow_tool_call: bool, base: &str, issues: &mut Vec<Issue>) {
    match content {
        Content::Text(text) => check_len(text, MAX_TEXT, &format!("{base}.content"), issues),
        Content::Blocks(blocks) => {
            if blocks.is_empty() {
                issues.push(issue(
                    &format!("{base}.content"),
                    "blocks array must not be empty",
                ));
                return;
            }
            if blocks.len() > MAX_BLOCKS {
                issues.push(issue(&format!("{base}.content"), "too many content blocks"));
            }
            for (j, block) in blocks.iter().enumerate() {
                validate_block(
                    block,
                    allow_tool_call,
                    &format!("{base}.content[{j}]"),
                    issues,
                );
            }
        }
    }
}

fn validate_block(block: &Block, allow_tool_call: bool, path: &str, issues: &mut Vec<Issue>) {
    match block {
        Block::Text { text } => check_len(text, MAX_TEXT, path, issues),
        Block::ToolCall {
            id,
            name,
            arguments,
        } => {
            if !allow_tool_call {
                issues.push(issue(
                    path,
                    "tool_call blocks are only allowed in assistant messages",
                ));
            }
            check_name(id, &format!("{path}.id"), issues);
            check_name(name, &format!("{path}.name"), issues);
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
                issues.push(issue(path, "exactly one of `source` or `url` must be set"));
            }
            if let Some(s) = source {
                check_len(s, MAX_BLOB, &format!("{path}.source"), issues);
            }
            if let Some(u) = url {
                check_len(u, MAX_URL, &format!("{path}.url"), issues);
            }
            check_name(media_type, &format!("{path}.media_type"), issues);
        }
    }
}

fn validate_usage(usage: &Usage, issues: &mut Vec<Issue>) {
    // Rust's `u64` already rules out negatives and non-integers; here we enforce the
    // consumer's `int4` ceiling and the documented cache/reasoning subset bounds.
    if usage.input_tokens > MAX_INT4 {
        issues.push(issue("usage.input_tokens", "exceeds maximum"));
    }
    if usage.output_tokens > MAX_INT4 {
        issues.push(issue("usage.output_tokens", "exceeds maximum"));
    }
    if let Some(cached) = usage.cached_tokens {
        if cached > MAX_INT4 {
            issues.push(issue("usage.cached_tokens", "exceeds maximum"));
        }
        if cached > usage.input_tokens {
            issues.push(issue("usage.cached_tokens", "must not exceed input_tokens"));
        }
    }
    if let Some(reasoning) = usage.reasoning_tokens {
        if reasoning > MAX_INT4 {
            issues.push(issue("usage.reasoning_tokens", "exceeds maximum"));
        }
        if reasoning > usage.output_tokens {
            issues.push(issue(
                "usage.reasoning_tokens",
                "must not exceed output_tokens",
            ));
        }
    }
}

/// A required identifier: non-empty (after trim) and within the name length bound.
fn check_name(s: &str, path: &str, issues: &mut Vec<Issue>) {
    if s.trim().is_empty() {
        issues.push(issue(path, "must not be empty"));
    } else if s.len() > MAX_NAME {
        issues.push(issue(path, "exceeds maximum length"));
    }
}

/// A free-text field: only bounded in length (may be empty).
fn check_len(s: &str, max: usize, path: &str, issues: &mut Vec<Issue>) {
    if s.len() > max {
        issues.push(issue(path, "exceeds maximum length"));
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
    use crate::event::{Event, Usage};
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

    #[test]
    fn empty_tool_call_id_and_name_are_rejected() {
        let mut e = minimal();
        e.messages = vec![Message::Assistant {
            content: Content::Blocks(vec![Block::ToolCall {
                id: "".into(),
                name: " ".into(),
                arguments: json!({}),
            }]),
        }];
        let err = validate(&e).unwrap_err();
        let p = paths(&err);
        assert!(p.contains(&"messages[0].content[0].id"));
        assert!(p.contains(&"messages[0].content[0].name"));
    }

    #[test]
    fn empty_blocks_array_is_rejected() {
        let mut e = minimal();
        e.messages = vec![Message::User {
            content: Content::Blocks(vec![]),
        }];
        let err = validate(&e).unwrap_err();
        assert_eq!(paths(&err), vec!["messages[0].content"]);
    }

    #[test]
    fn cached_tokens_exceeding_input_is_rejected() {
        let mut e = minimal();
        e.usage = Some(Usage {
            input_tokens: 10,
            output_tokens: 5,
            cached_tokens: Some(9999),
            reasoning_tokens: None,
        });
        let err = validate(&e).unwrap_err();
        assert_eq!(paths(&err), vec!["usage.cached_tokens"]);
    }

    #[test]
    fn tokens_over_int4_are_rejected() {
        let mut e = minimal();
        e.usage = Some(Usage {
            input_tokens: 3_000_000_000,
            output_tokens: 1,
            cached_tokens: None,
            reasoning_tokens: None,
        });
        let err = validate(&e).unwrap_err();
        assert_eq!(paths(&err), vec!["usage.input_tokens"]);
    }
}
