//! Regenerate the shared valid conformance fixtures from the canonical types.
//!
//! Rust is the source of truth: this writes `../fixtures/valid/*.json`, which the
//! TS and Python clients round-trip in CI. Run with:
//!
//! ```bash
//! cargo run -p ratel-ai-cloud --example dump_fixtures
//! ```
//!
//! A clean `git diff` afterwards proves the committed fixtures match the schema.
//! Invalid fixtures (`../fixtures/invalid/*.json`) are hand-authored — they must
//! deserialize but fail `validate()` — and are not touched here.

use std::fs;
use std::path::Path;

use ratel_ai_cloud::{
    Block, Content, Event, FinishReason, Message, Params, ToolDef, Usage, validate,
};
use serde_json::json;

fn main() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/valid");
    fs::create_dir_all(&dir).expect("create fixtures/valid");

    for (name, event) in fixtures() {
        validate(&event).unwrap_or_else(|e| panic!("fixture {name} is invalid: {e}"));
        let mut json = serde_json::to_string_pretty(&event).expect("serialize fixture");
        json.push('\n');
        let path = dir.join(format!("{name}.json"));
        fs::write(&path, json).unwrap_or_else(|e| panic!("write {path:?}: {e}"));
        println!("wrote {}", path.display());
    }
}

fn fixtures() -> Vec<(&'static str, Event)> {
    vec![
        (
            "minimal",
            Event {
                provider: "openai".into(),
                model: "gpt-5.5".into(),
                ts: "2026-06-30T12:00:00Z".into(),
                stream: false,
                latency_ms: None,
                system: None,
                tools: Vec::new(),
                messages: vec![Message::User {
                    content: Content::Text("Weather in Paris?".into()),
                }],
                params: None,
                usage: None,
                finish_reason: None,
            },
        ),
        (
            "tool_call",
            Event {
                provider: "openai".into(),
                model: "gpt-5.5".into(),
                ts: "2026-06-30T12:00:00Z".into(),
                stream: false,
                latency_ms: Some(842),
                system: Some("You are a weather assistant.".into()),
                tools: vec![ToolDef {
                    name: "get_weather".into(),
                    description: Some("Look up the weather for a location.".into()),
                    parameters: json!({
                        "type": "object",
                        "properties": { "location": { "type": "string" } },
                        "required": ["location"]
                    }),
                }],
                messages: vec![
                    Message::User {
                        content: Content::Text("Weather in Paris?".into()),
                    },
                    Message::Assistant {
                        content: Content::Blocks(vec![
                            Block::Text {
                                text: "Let me check.".into(),
                            },
                            Block::ToolCall {
                                id: "call_9x".into(),
                                name: "get_weather".into(),
                                arguments: json!({ "location": "Paris" }),
                            },
                        ]),
                    },
                    Message::Tool {
                        tool_call_id: "call_9x".into(),
                        content: "18°C, cloudy".into(),
                    },
                ],
                params: Some(Params {
                    temperature: Some(0.7),
                    top_p: Some(1.0),
                    max_tokens: Some(512),
                    stop: Some(vec!["\n\n".into()]),
                }),
                usage: Some(Usage {
                    input_tokens: 82,
                    output_tokens: 41,
                    cached_tokens: Some(0),
                    reasoning_tokens: Some(22),
                }),
                finish_reason: Some(FinishReason::ToolCall),
            },
        ),
        (
            "multimodal",
            Event {
                provider: "anthropic".into(),
                model: "claude-opus-4-8".into(),
                ts: "2026-06-30T12:05:00Z".into(),
                stream: true,
                latency_ms: Some(1203),
                system: None,
                tools: Vec::new(),
                messages: vec![
                    Message::User {
                        content: Content::Blocks(vec![
                            Block::Text {
                                text: "Describe this image.".into(),
                            },
                            Block::Image {
                                source: Some("iVBORw0KGgo=".into()),
                                url: None,
                                media_type: "image/png".into(),
                            },
                        ]),
                    },
                    Message::Assistant {
                        content: Content::Text("A red square.".into()),
                    },
                ],
                params: None,
                usage: Some(Usage {
                    input_tokens: 1024,
                    output_tokens: 12,
                    cached_tokens: None,
                    reasoning_tokens: None,
                }),
                finish_reason: Some(FinishReason::Stop),
            },
        ),
    ]
}
