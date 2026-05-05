use ratel_ai_core::{Tool, ToolRegistry};
use serde_json::json;

fn empty_schema() -> serde_json::Value {
    json!({})
}

#[test]
fn empty_registry_returns_no_results() {
    let registry = ToolRegistry::new();
    let hits = registry.search("anything", 5);
    assert!(hits.is_empty());
}

#[test]
fn snake_case_name_is_split_for_natural_language_queries() {
    let mut registry = ToolRegistry::new();
    registry.register(Tool {
        id: "search_files".into(),
        name: "search_files".into(),
        description: String::new(),
        input_schema: empty_schema(),
        output_schema: empty_schema(),
    });
    registry.register(Tool {
        id: "decoy".into(),
        name: "decoy".into(),
        description: "unrelated background tool".into(),
        input_schema: empty_schema(),
        output_schema: empty_schema(),
    });

    let hits = registry.search("search", 5);

    assert!(
        !hits.is_empty(),
        "expected snake_case name to match its parts"
    );
    assert_eq!(hits[0].tool_id, "search_files");
}

#[test]
fn camel_case_name_is_split_for_natural_language_queries() {
    let mut registry = ToolRegistry::new();
    registry.register(Tool {
        id: "computeHash".into(),
        name: "computeHash".into(),
        description: String::new(),
        input_schema: empty_schema(),
        output_schema: empty_schema(),
    });

    let hits = registry.search("compute", 5);

    assert!(
        !hits.is_empty(),
        "expected camelCase name to match its parts"
    );
    assert_eq!(hits[0].tool_id, "computeHash");
}

#[test]
fn kebab_case_property_key_is_split_for_natural_language_queries() {
    let mut registry = ToolRegistry::new();
    registry.register(Tool {
        id: "tool".into(),
        name: "tool".into(),
        description: String::new(),
        input_schema: json!({
            "properties": {
                "user-id": {}
            }
        }),
        output_schema: empty_schema(),
    });

    let hits = registry.search("user", 5);

    assert!(
        !hits.is_empty(),
        "expected kebab-case key to match its parts"
    );
    assert_eq!(hits[0].tool_id, "tool");
}

#[test]
fn re_registering_same_id_replaces_entry() {
    let mut registry = ToolRegistry::new();
    registry.register(Tool {
        id: "shared".into(),
        name: "shared".into(),
        description: "yodel mountain".into(),
        input_schema: empty_schema(),
        output_schema: empty_schema(),
    });
    registry.register(Tool {
        id: "shared".into(),
        name: "shared".into(),
        description: "kitchen pancake".into(),
        input_schema: empty_schema(),
        output_schema: empty_schema(),
    });

    let stale_hits = registry.search("yodel mountain", 5);
    let fresh_hits = registry.search("kitchen pancake", 5);

    assert!(
        stale_hits.is_empty(),
        "old description should not match anymore"
    );
    assert_eq!(fresh_hits.len(), 1);
    assert_eq!(fresh_hits[0].tool_id, "shared");
}

#[test]
fn search_ranks_stronger_match_above_weaker() {
    let mut registry = ToolRegistry::new();
    registry.register(Tool {
        id: "strong".into(),
        name: "compress".into(),
        description: "compress directories into compress archives quickly".into(),
        input_schema: empty_schema(),
        output_schema: empty_schema(),
    });
    registry.register(Tool {
        id: "weak".into(),
        name: "convert".into(),
        description: String::new(),
        input_schema: json!({
            "properties": {
                "format": {
                    "type": "string",
                    "enum": ["compress", "expand"]
                }
            }
        }),
        output_schema: empty_schema(),
    });

    let hits = registry.search("compress", 5);

    assert!(
        hits.len() >= 2,
        "expected both tools to match, got {}",
        hits.len()
    );
    assert_eq!(hits[0].tool_id, "strong");
    assert_eq!(hits[1].tool_id, "weak");
    assert!(hits[0].score > hits[1].score);
}

#[test]
fn search_respects_top_k_bound() {
    let mut registry = ToolRegistry::new();
    for i in 0..5 {
        registry.register(Tool {
            id: format!("tool_{i}"),
            name: format!("tool_{i}"),
            description: "shared keyword shrubbery".into(),
            input_schema: empty_schema(),
            output_schema: empty_schema(),
        });
    }

    let hits = registry.search("shrubbery", 3);

    assert!(
        hits.len() <= 3,
        "expected at most 3 hits, got {}",
        hits.len()
    );
}

#[test]
fn search_matches_output_schema_description() {
    let mut registry = ToolRegistry::new();
    registry.register(Tool {
        id: "weather".into(),
        name: "weather".into(),
        description: String::new(),
        input_schema: empty_schema(),
        output_schema: json!({
            "properties": {
                "temperature_celsius": {
                    "type": "number",
                    "description": "ambient temperature reading at the station"
                }
            }
        }),
    });

    let hits = registry.search("ambient temperature reading", 5);

    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].tool_id, "weather");
}

#[test]
fn search_matches_nested_object_description() {
    let mut registry = ToolRegistry::new();
    registry.register(Tool {
        id: "deploy".into(),
        name: "deploy".into(),
        description: String::new(),
        input_schema: json!({
            "properties": {
                "config": {
                    "type": "object",
                    "properties": {
                        "infra": {
                            "type": "object",
                            "properties": {
                                "region": {
                                    "type": "string",
                                    "description": "datacenter location identifier"
                                }
                            }
                        }
                    }
                }
            }
        }),
        output_schema: empty_schema(),
    });

    let hits = registry.search("datacenter location identifier", 5);

    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].tool_id, "deploy");
}

#[test]
fn search_matches_array_items_description() {
    let mut registry = ToolRegistry::new();
    registry.register(Tool {
        id: "batch".into(),
        name: "batch".into(),
        description: String::new(),
        input_schema: json!({
            "properties": {
                "items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "sku": {
                                "type": "string",
                                "description": "unique product identifier"
                            }
                        }
                    }
                }
            }
        }),
        output_schema: empty_schema(),
    });

    let hits = registry.search("unique product identifier", 5);

    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].tool_id, "batch");
}

#[test]
fn search_matches_enum_value() {
    let mut registry = ToolRegistry::new();
    registry.register(Tool {
        id: "convert".into(),
        name: "convert".into(),
        description: String::new(),
        input_schema: json!({
            "properties": {
                "format": {
                    "type": "string",
                    "enum": ["yaml", "toml", "json"]
                }
            }
        }),
        output_schema: empty_schema(),
    });

    let hits = registry.search("toml", 5);

    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].tool_id, "convert");
}

#[test]
fn search_matches_input_param_description() {
    let mut registry = ToolRegistry::new();
    registry.register(Tool {
        id: "fetch".into(),
        name: "fetch".into(),
        description: String::new(),
        input_schema: json!({
            "properties": {
                "url": {
                    "type": "string",
                    "description": "remote http target to retrieve"
                }
            }
        }),
        output_schema: empty_schema(),
    });

    let hits = registry.search("remote http target", 5);

    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].tool_id, "fetch");
}

#[test]
fn search_matches_input_param_name() {
    let mut registry = ToolRegistry::new();
    registry.register(Tool {
        id: "fetch".into(),
        name: "fetch".into(),
        description: String::new(),
        input_schema: json!({
            "properties": {
                "endpoint": {}
            }
        }),
        output_schema: empty_schema(),
    });

    let hits = registry.search("endpoint", 5);

    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].tool_id, "fetch");
}

#[test]
fn search_matches_tool_description() {
    let mut registry = ToolRegistry::new();
    registry.register(Tool {
        id: "diff".into(),
        name: "diff".into(),
        description: "compute the unified textual difference between two files".into(),
        input_schema: empty_schema(),
        output_schema: empty_schema(),
    });

    let hits = registry.search("unified textual difference", 5);

    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].tool_id, "diff");
    assert!(hits[0].score > 0.0);
}

#[test]
fn search_matches_tool_name() {
    let mut registry = ToolRegistry::new();
    registry.register(Tool {
        id: "read_file".into(),
        name: "read_file".into(),
        description: String::new(),
        input_schema: empty_schema(),
        output_schema: empty_schema(),
    });

    let hits = registry.search("read_file", 5);

    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].tool_id, "read_file");
    assert!(hits[0].score > 0.0);
}
