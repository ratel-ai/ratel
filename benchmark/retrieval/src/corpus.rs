//! Normalized scenario format consumed by both benchmark layers.
//!
//! On disk, scenarios live as JSON Lines (one `Scenario` per line). The format
//! is the contract between any corpus adapter (e.g. ToolBench → JSONL) and the
//! retrieval / agent layers, so both halves see identical inputs.

use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A tool definition. Mirrors `ratel_ai_core::Tool` but adds serde derives so the
/// type can round-trip through JSONL without touching the core lib.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolSpec {
    pub id: String,
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    #[serde(default = "empty_object")]
    pub output_schema: Value,
}

impl From<ToolSpec> for ratel_ai_core::Tool {
    fn from(spec: ToolSpec) -> Self {
        ratel_ai_core::Tool {
            id: spec.id,
            name: spec.name,
            description: spec.description,
            input_schema: spec.input_schema,
            output_schema: spec.output_schema,
        }
    }
}

impl From<&ToolSpec> for ratel_ai_core::Tool {
    fn from(spec: &ToolSpec) -> Self {
        ratel_ai_core::Tool {
            id: spec.id.clone(),
            name: spec.name.clone(),
            description: spec.description.clone(),
            input_schema: spec.input_schema.clone(),
            output_schema: spec.output_schema.clone(),
        }
    }
}

/// A single benchmark scenario.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Scenario {
    pub id: String,
    pub prompt: String,
    pub candidate_pool: Vec<ToolSpec>,
    pub gold_tools: Vec<String>,
    #[serde(default)]
    pub judge_criteria: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
}

fn empty_object() -> Value {
    Value::Object(Default::default())
}

/// Parse a JSONL stream of scenarios. Blank lines are skipped. Errors carry the
/// 1-indexed line number to make broken corpora debuggable.
pub fn parse_scenarios<R: BufRead>(reader: R) -> anyhow::Result<Vec<Scenario>> {
    let mut out = Vec::new();
    for (idx, line) in reader.lines().enumerate() {
        let line = line?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let scenario: Scenario = serde_json::from_str(trimmed)
            .map_err(|e| anyhow::anyhow!("failed to parse scenario at line {}: {}", idx + 1, e))?;
        out.push(scenario);
    }
    Ok(out)
}

/// Load scenarios from a JSONL file on disk.
pub fn load_scenarios<P: AsRef<Path>>(path: P) -> anyhow::Result<Vec<Scenario>> {
    let file = File::open(path.as_ref())
        .map_err(|e| anyhow::anyhow!("opening {}: {e}", path.as_ref().display()))?;
    parse_scenarios(BufReader::new(file))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Cursor;

    fn read_file_spec() -> ToolSpec {
        ToolSpec {
            id: "fs.read_file".into(),
            name: "read_file".into(),
            description: "Read a file from disk.".into(),
            input_schema: json!({
                "properties": {
                    "path": { "type": "string", "description": "absolute path" }
                },
                "required": ["path"]
            }),
            output_schema: json!({}),
        }
    }

    fn sample_scenario() -> Scenario {
        Scenario {
            id: "fs-001".into(),
            prompt: "Show me the contents of /etc/hosts".into(),
            candidate_pool: vec![read_file_spec()],
            gold_tools: vec!["fs.read_file".into()],
            judge_criteria: Some("Mentions localhost".into()),
            category: Some("filesystem".into()),
        }
    }

    #[test]
    fn parse_empty_input_yields_no_scenarios() {
        let scenarios = parse_scenarios(Cursor::new("")).unwrap();
        assert!(scenarios.is_empty());
    }

    #[test]
    fn parse_skips_blank_lines() {
        let scenario = sample_scenario();
        let line = serde_json::to_string(&scenario).unwrap();
        let input = format!("\n{line}\n\n");
        let scenarios = parse_scenarios(Cursor::new(input)).unwrap();
        assert_eq!(scenarios, vec![scenario]);
    }

    #[test]
    fn parse_round_trips_a_scenario() {
        let scenario = sample_scenario();
        let serialized = serde_json::to_string(&scenario).unwrap();
        let parsed = parse_scenarios(Cursor::new(serialized)).unwrap();
        assert_eq!(parsed, vec![scenario]);
    }

    #[test]
    fn parse_handles_multiple_scenarios() {
        let s1 = sample_scenario();
        let mut s2 = sample_scenario();
        s2.id = "fs-002".into();
        let input = format!(
            "{}\n{}\n",
            serde_json::to_string(&s1).unwrap(),
            serde_json::to_string(&s2).unwrap()
        );
        let parsed = parse_scenarios(Cursor::new(input)).unwrap();
        assert_eq!(parsed, vec![s1, s2]);
    }

    #[test]
    fn parse_error_carries_line_number() {
        let valid = serde_json::to_string(&sample_scenario()).unwrap();
        let input = format!("{valid}\n{{ this is not json\n");
        let err = parse_scenarios(Cursor::new(input)).unwrap_err();
        let msg = format!("{err}");
        assert!(
            msg.contains("line 2"),
            "expected error to mention line 2, got: {msg}"
        );
    }

    #[test]
    fn tool_spec_converts_to_ratel_ai_core_tool() {
        let spec = read_file_spec();
        let tool: ratel_ai_core::Tool = (&spec).into();
        assert_eq!(tool.id, spec.id);
        assert_eq!(tool.name, spec.name);
        assert_eq!(tool.description, spec.description);
        assert_eq!(tool.input_schema, spec.input_schema);
        assert_eq!(tool.output_schema, spec.output_schema);
    }

    #[test]
    fn optional_fields_default_when_missing() {
        let json = r#"{"id":"fs-003","prompt":"x","candidate_pool":[],"gold_tools":[]}"#;
        let parsed = parse_scenarios(Cursor::new(json)).unwrap();
        assert_eq!(parsed.len(), 1);
        assert!(parsed[0].judge_criteria.is_none());
        assert!(parsed[0].category.is_none());
    }

    #[test]
    fn parses_selection_only_row_without_gold_trace() {
        // MetaTool / ToolRet rows ship without a gold tool-call trace — only
        // {id, prompt, candidate_pool, gold_tools}. The harness must accept them.
        let json = r#"{"id":"meta-001","prompt":"convert 100 USD to EUR","candidate_pool":[{"id":"fx.convert","name":"convert","description":"Currency conversion.","input_schema":{}}],"gold_tools":["fx.convert"]}"#;
        let parsed = parse_scenarios(Cursor::new(json)).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].id, "meta-001");
        assert_eq!(parsed[0].gold_tools, vec!["fx.convert".to_string()]);
    }

    #[test]
    fn load_scenarios_from_path_works() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("scenarios.jsonl");
        let scenario = sample_scenario();
        std::fs::write(&path, serde_json::to_string(&scenario).unwrap()).unwrap();
        let parsed = load_scenarios(&path).unwrap();
        assert_eq!(parsed, vec![scenario]);
    }

    #[test]
    fn load_scenarios_missing_path_returns_helpful_error() {
        let err = load_scenarios("/nonexistent/path/scenarios.jsonl").unwrap_err();
        let msg = format!("{err}");
        assert!(
            msg.contains("/nonexistent/path/scenarios.jsonl"),
            "expected error to mention the path, got: {msg}"
        );
    }
}
