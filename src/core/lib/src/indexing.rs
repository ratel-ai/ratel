use crate::tool::Tool;

pub(crate) fn searchable_text(tool: &Tool) -> String {
    let mut tokens: Vec<String> = Vec::new();
    if !tool.name.is_empty() {
        push_identifier(&tool.name, &mut tokens);
    }
    if !tool.description.is_empty() {
        tokens.push(tool.description.clone());
    }
    flatten(&tool.input_schema, &mut tokens);
    flatten(&tool.output_schema, &mut tokens);
    tokens.join(" ")
}

fn flatten(value: &serde_json::Value, tokens: &mut Vec<String>) {
    if let Some(properties) = value.get("properties").and_then(|v| v.as_object()) {
        for (key, sub) in properties {
            push_identifier(key, tokens);
            push_field_tokens(sub, tokens);
            flatten(sub, tokens);
        }
    }
    if let Some(items) = value.get("items") {
        flatten(items, tokens);
    }
}

// Push the original identifier and, if it differs, a space-split form so that
// the bm25 crate's UAX #29 tokenizer (which keeps `snake_case` and `camelCase`
// whole) still surfaces the constituent words.
pub(crate) fn push_identifier(s: &str, tokens: &mut Vec<String>) {
    tokens.push(s.to_string());
    let split = split_identifier(s);
    if split != s {
        tokens.push(split);
    }
}

pub(crate) fn split_identifier(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 4);
    let mut prev: Option<char> = None;
    for c in s.chars() {
        if c == '_' {
            out.push(' ');
        } else if c.is_uppercase() && matches!(prev, Some(p) if p.is_lowercase()) {
            out.push(' ');
            out.push(c);
        } else {
            out.push(c);
        }
        prev = Some(c);
    }
    out
}

fn push_field_tokens(sub: &serde_json::Value, tokens: &mut Vec<String>) {
    if let Some(desc) = sub.get("description").and_then(|v| v.as_str()) {
        tokens.push(desc.to_string());
    }
    if let Some(values) = sub.get("enum").and_then(|v| v.as_array()) {
        for v in values {
            if let Some(s) = v.as_str() {
                tokens.push(s.to_string());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn read_file_tool() -> Tool {
        Tool {
            id: "read_file".into(),
            name: "read_file".into(),
            description: "Read a file from disk".into(),
            input_schema: json!({
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "absolute path"
                    },
                    "encoding": {
                        "type": "string",
                        "enum": ["utf8", "binary"],
                        "description": "file encoding"
                    }
                }
            }),
            output_schema: json!({}),
        }
    }

    #[test]
    fn searchable_text_is_deterministic() {
        let tool = read_file_tool();
        let first = searchable_text(&tool);
        let second = searchable_text(&tool);
        assert_eq!(first, second);
    }

    #[test]
    fn searchable_text_preserves_schema_defined_property_order() {
        let tool = read_file_tool();
        let text = searchable_text(&tool);
        let path_idx = text.find("path").expect("path token missing");
        let encoding_idx = text.find("encoding").expect("encoding token missing");
        assert!(
            path_idx < encoding_idx,
            "expected schema-defined order (path before encoding) in: {text}"
        );
    }

    #[test]
    fn searchable_text_omits_json_structure_keywords() {
        let tool = read_file_tool();
        let text = searchable_text(&tool);
        // Tokens we explicitly skip: type names, structural keys, JSON syntax.
        assert!(
            !text.contains("\"type\""),
            "raw type quoting leaked: {text}"
        );
        assert!(
            !text.contains("\"properties\""),
            "properties leaked: {text}"
        );
        assert!(!text.contains('{'), "JSON braces leaked: {text}");
    }

    #[test]
    fn split_identifier_splits_snake_and_camel_case() {
        assert_eq!(split_identifier("search_files"), "search files");
        assert_eq!(split_identifier("computeHash"), "compute Hash");
        assert_eq!(split_identifier("read_file_v2"), "read file v2");
        // No separators → unchanged (kebab-case is left to the bm25 tokenizer).
        assert_eq!(split_identifier("plain"), "plain");
        assert_eq!(split_identifier("user-id"), "user-id");
    }

    #[test]
    fn push_identifier_keeps_original_and_adds_split_form() {
        let mut tokens = Vec::new();
        push_identifier("search_files", &mut tokens);
        assert!(tokens.contains(&"search_files".to_string()));
        assert!(tokens.contains(&"search files".to_string()));
    }

    #[test]
    fn searchable_text_includes_property_names_descriptions_and_enums() {
        let text = searchable_text(&read_file_tool());
        // Property keys, their descriptions, and enum values all become tokens.
        for token in [
            "path",
            "absolute path",
            "encoding",
            "file encoding",
            "utf8",
            "binary",
        ] {
            assert!(text.contains(token), "missing {token:?} in: {text}");
        }
    }

    #[test]
    fn flatten_reaches_nested_object_and_array_item_descriptions() {
        let tool = Tool {
            id: "deploy".into(),
            name: "deploy".into(),
            description: String::new(),
            input_schema: json!({
                "properties": {
                    "config": {
                        "type": "object",
                        "properties": {
                            "region": {
                                "type": "string",
                                "description": "datacenter location identifier"
                            }
                        }
                    },
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
            output_schema: json!({}),
        };
        let text = searchable_text(&tool);
        assert!(
            text.contains("datacenter location identifier"),
            "nested object description missing: {text}"
        );
        assert!(
            text.contains("unique product identifier"),
            "array item description missing: {text}"
        );
    }

    #[test]
    fn flatten_covers_the_output_schema() {
        let tool = Tool {
            id: "weather".into(),
            name: "weather".into(),
            description: String::new(),
            input_schema: json!({}),
            output_schema: json!({
                "properties": {
                    "temperature_celsius": {
                        "type": "number",
                        "description": "ambient temperature reading at the station"
                    }
                }
            }),
        };
        let text = searchable_text(&tool);
        assert!(
            text.contains("ambient temperature reading at the station"),
            "output schema description missing: {text}"
        );
    }
}
