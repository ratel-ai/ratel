//! The catalog from issue #56, ranked by the flattened scorer and by
//! experimental field weights (ADR-0025).

use ratel_ai_core::{FieldParams, FieldWeights, Tool, ToolRegistry};
use serde_json::json;

const QUERY: &str = "look for documentation about deployment configuration";

/// The twelve tools from the issue, with its shared schema.
fn catalog() -> Vec<Tool> {
    let tools = [
        (
            "read_file",
            "Read a file from local disk and return its textual contents.",
        ),
        (
            "search_code",
            "Search source code across a repository for keywords, symbols, or configuration values.",
        ),
        (
            "search_docs",
            "Search project documentation, markdown files, and technical docs for relevant explanations.",
        ),
        (
            "search_logs",
            "Search application logs and runtime logs for errors, warnings, and diagnostics.",
        ),
        (
            "read_env_file",
            "Read environment variable files such as .env, .env.production, or deployment config files.",
        ),
        (
            "read_config_file",
            "Read structured configuration files like JSON, YAML, TOML, or application config files.",
        ),
        (
            "send_email",
            "Send an email message to one or more recipients.",
        ),
        (
            "send_slack_message",
            "Send a Slack message to a user or channel.",
        ),
        (
            "currency_convert",
            "Convert an amount of money from one currency to another using exchange rates.",
        ),
        (
            "weather_lookup",
            "Look up weather forecast for a city or location.",
        ),
        (
            "create_issue",
            "Create a GitHub issue with title, body, labels, and assignee information.",
        ),
        (
            "create_pull_request",
            "Create a GitHub pull request with title, description, and branch information.",
        ),
    ];
    tools
        .into_iter()
        .map(|(id, description)| Tool {
            id: id.into(),
            name: id.into(),
            description: description.into(),
            experimental_searchable_description: None,
            input_schema: json!({
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Natural language request or search query"
                    },
                    "path": {
                        "type": "string",
                        "description": "Optional file path or directory path"
                    },
                    "pattern": {
                        "type": "string",
                        "description": "Optional keyword or regular expression pattern"
                    }
                }
            }),
            output_schema: json!({
                "properties": {
                    "summary": {
                        "type": "string",
                        "description": "Textual summary of the tool result"
                    }
                }
            }),
        })
        .collect()
}

fn registry() -> ToolRegistry {
    let mut registry = ToolRegistry::new();
    for tool in catalog() {
        registry.register(tool);
    }
    registry
}

fn ranked(registry: &ToolRegistry, query: &str, top_k: usize) -> Vec<(String, f32)> {
    registry
        .search(query, top_k)
        .into_iter()
        .map(|hit| (hit.tool_id, hit.score))
        .collect()
}

fn line(ranked: &[(String, f32)]) -> String {
    ranked
        .iter()
        .map(|(id, score)| format!("{id}:{score:.4}"))
        .collect::<Vec<_>>()
        .join("  ")
}

#[test]
fn flattened_ranking_puts_the_weather_tool_first() {
    // The reported behavior: "look" carries weather_lookup above the tool the
    // query actually asks for.
    let hits = ranked(&registry(), QUERY, 5);
    println!("[flattened] {}", line(&hits));
    assert_eq!(hits[0].0, "weather_lookup");
    assert_eq!(hits[1].0, "search_docs");
}

#[test]
fn probe_field_weight_settings() {
    let settings: Vec<(&str, FieldWeights)> = vec![
        ("default", FieldWeights::default()),
        (
            "name 1.0 / description 1.0 / schema 1.0, b as default",
            FieldWeights {
                name: FieldParams {
                    weight: 1.0,
                    b: 0.3,
                },
                description: FieldParams {
                    weight: 1.0,
                    b: 0.4,
                },
                schema: FieldParams {
                    weight: 1.0,
                    b: 0.6,
                },
            },
        ),
        (
            "description b = 0.0",
            FieldWeights {
                description: FieldParams {
                    weight: 1.0,
                    b: 0.0,
                },
                ..FieldWeights::default()
            },
        ),
        (
            "description b = 1.0",
            FieldWeights {
                description: FieldParams {
                    weight: 1.0,
                    b: 1.0,
                },
                ..FieldWeights::default()
            },
        ),
        (
            "schema weight 0.0",
            FieldWeights {
                schema: FieldParams {
                    weight: 0.0,
                    b: 0.6,
                },
                ..FieldWeights::default()
            },
        ),
        (
            "name weight 4.0",
            FieldWeights {
                name: FieldParams {
                    weight: 4.0,
                    b: 0.3,
                },
                ..FieldWeights::default()
            },
        ),
    ];

    for (label, weights) in settings {
        let mut registry = registry();
        registry.experimental_enable_field_weighted_ranking(weights);
        println!("[{label}] {}", line(&ranked(&registry, QUERY, 5)));
    }

    // Per-term probes, to see which single term carries each tool.
    let mut registry = registry();
    registry.experimental_enable_field_weighted_ranking(FieldWeights::default());
    for term in ["look", "documentation", "deployment", "configuration"] {
        println!("[term {term}] {}", line(&ranked(&registry, term, 3)));
    }
}

#[test]
fn disabling_restores_the_flattened_ranking() {
    let before = ranked(&registry(), QUERY, 5);

    let mut registry = registry();
    registry.experimental_enable_field_weighted_ranking(FieldWeights::default());
    assert!(registry.experimental_field_weighted_ranking().is_some());
    registry.experimental_disable_field_weighted_ranking();
    assert!(registry.experimental_field_weighted_ranking().is_none());

    assert_eq!(ranked(&registry, QUERY, 5), before);
}

#[test]
fn field_weighted_ranking_is_deterministic() {
    let mut first = registry();
    first.experimental_enable_field_weighted_ranking(FieldWeights::default());
    let mut second = registry();
    second.experimental_enable_field_weighted_ranking(FieldWeights::default());

    assert_eq!(ranked(&first, QUERY, 12), ranked(&second, QUERY, 12));
    assert_eq!(ranked(&first, QUERY, 12), ranked(&first, QUERY, 12));
}
