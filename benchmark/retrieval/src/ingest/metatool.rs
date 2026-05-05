//! MetaTool → normalized [`crate::corpus::Scenario`] JSONL adapter.
//!
//! Source: <https://github.com/HowieHwong/MetaTool> (MIT).
//!
//! Upstream layout (under `dataset/`):
//! - `plugin_des.json` — `{ plugin_name: human_description }` over 199 plugins.
//! - `data/all_clean_data.csv` — single-tool queries, columns `Query,Tool`.
//! - `data/multi_tool_query_golden.json` — `[{ query, tool: [...] }]`.
//!
//! Mapping rules (per ADR-0006):
//! - Tool universe = `plugin_des.json`. `id == name == plugin key`. Schemas empty.
//! - Single-tool query → one [`Scenario`] with one gold tool; id `metatool-st-<line>`.
//! - Multi-tool query → one [`Scenario`] with N gold tools; id `metatool-mt-<index>`.
//! - Per-row `candidate_pool` carries only gold tool(s); the runner pools
//!   distractors across scenarios at retrieval time.
//! - Queries whose gold tool is not in `plugin_des.json` are skipped (counted).

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};

use anyhow::Context;
use serde::Deserialize;
use serde_json::Value;

use crate::corpus::{Scenario, ToolSpec};

/// Canonical raw URLs for the three MetaTool source files (master branch).
///
/// Pinned here so the CLI's `--download` path and any future automation share
/// one source of truth. The upstream commit SHA is tracked in ADR-0007.
pub const PLUGIN_DES_URL: &str =
    "https://raw.githubusercontent.com/HowieHwong/MetaTool/master/dataset/plugin_des.json";
pub const SINGLE_TOOL_CSV_URL: &str =
    "https://raw.githubusercontent.com/HowieHwong/MetaTool/master/dataset/data/all_clean_data.csv";
pub const MULTI_TOOL_JSON_URL: &str = "https://raw.githubusercontent.com/HowieHwong/MetaTool/master/dataset/data/multi_tool_query_golden.json";

/// Paths to the upstream MetaTool files.
#[derive(Debug, Clone)]
pub struct MetaToolPaths {
    pub plugins: PathBuf,
    pub single_tool: PathBuf,
    pub multi_tool: Option<PathBuf>,
}

impl MetaToolPaths {
    /// Default paths for upstream MetaTool sources under a fixtures directory,
    /// laid out to mirror the upstream `dataset/` tree.
    pub fn under_fixtures_dir(fixtures_dir: &Path) -> Self {
        Self {
            plugins: fixtures_dir.join("dataset/plugin_des.json"),
            single_tool: fixtures_dir.join("dataset/data/all_clean_data.csv"),
            multi_tool: Some(fixtures_dir.join("dataset/data/multi_tool_query_golden.json")),
        }
    }
}

/// Counters for one ingestion run. Useful for the CLI to print a summary and
/// for tests to assert filtering behavior.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct IngestStats {
    pub plugins_loaded: usize,
    pub single_tool_in: usize,
    pub multi_tool_in: usize,
    pub scenarios_out: usize,
    pub skipped_unknown_gold: usize,
}

#[derive(Debug, Clone, PartialEq)]
struct RawSingleQuery {
    /// 1-indexed CSV line number (header is line 1, first data row is line 2).
    line: usize,
    query: String,
    tool: String,
}

#[derive(Debug, Clone, PartialEq)]
struct RawMultiQuery {
    /// 0-indexed position in upstream JSON array.
    index: usize,
    query: String,
    tools: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct MultiToolRecord {
    query: String,
    tool: Vec<String>,
}

/// Read MetaTool inputs and write a normalized JSONL to `output`. Emits one
/// scenario per upstream query that has a known gold tool; the rest are
/// counted in `IngestStats::skipped_unknown_gold`.
pub fn ingest_to_jsonl(paths: &MetaToolPaths, output: &Path) -> anyhow::Result<IngestStats> {
    let plugins_json = std::fs::read_to_string(&paths.plugins)
        .with_context(|| format!("reading plugins file {}", paths.plugins.display()))?;
    let plugins = parse_plugin_des(&plugins_json)?;

    let csv_file = File::open(&paths.single_tool)
        .with_context(|| format!("opening {}", paths.single_tool.display()))?;
    let single = parse_single_tool_csv(BufReader::new(csv_file))?;

    let multi: Vec<RawMultiQuery> = match &paths.multi_tool {
        Some(path) => {
            let json = std::fs::read_to_string(path)
                .with_context(|| format!("reading multi-tool file {}", path.display()))?;
            parse_multi_tool_json(&json)?
        }
        None => Vec::new(),
    };

    let (scenarios, mut stats) = build_scenarios(&single, &multi, &plugins);
    stats.plugins_loaded = plugins.len();

    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating output dir {}", parent.display()))?;
    }
    let out_file =
        File::create(output).with_context(|| format!("creating {}", output.display()))?;
    let mut writer = BufWriter::new(out_file);
    for s in &scenarios {
        writeln!(writer, "{}", serde_json::to_string(s)?)?;
    }
    writer.flush()?;

    Ok(stats)
}

fn parse_plugin_des(json: &str) -> anyhow::Result<HashMap<String, ToolSpec>> {
    let raw: HashMap<String, String> =
        serde_json::from_str(json).context("parsing plugin_des.json")?;
    Ok(raw
        .into_iter()
        .map(|(name, description)| {
            let spec = ToolSpec {
                id: name.clone(),
                name: name.clone(),
                description: description.trim().to_string(),
                input_schema: Value::Object(Default::default()),
                output_schema: Value::Object(Default::default()),
            };
            (name, spec)
        })
        .collect())
}

fn parse_single_tool_csv<R: Read>(reader: R) -> anyhow::Result<Vec<RawSingleQuery>> {
    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(true)
        .flexible(true)
        .from_reader(reader);
    let mut out = Vec::new();
    for (offset, record) in rdr.records().enumerate() {
        let record = record.context("reading CSV row")?;
        // CSV records are 0-indexed *after* the header. Add 2 to convert to the
        // 1-indexed file line (1 = header, 2 = first data row).
        let line = offset + 2;
        let query = record.get(0).unwrap_or("").trim().to_string();
        let tool = record.get(1).unwrap_or("").trim().to_string();
        if query.is_empty() || tool.is_empty() {
            continue;
        }
        out.push(RawSingleQuery { line, query, tool });
    }
    Ok(out)
}

fn parse_multi_tool_json(json: &str) -> anyhow::Result<Vec<RawMultiQuery>> {
    let raw: Vec<MultiToolRecord> =
        serde_json::from_str(json).context("parsing multi_tool_query_golden.json")?;
    Ok(raw
        .into_iter()
        .enumerate()
        .map(|(index, r)| RawMultiQuery {
            index,
            query: r.query,
            tools: r.tool,
        })
        .collect())
}

fn build_single_scenario(
    q: &RawSingleQuery,
    plugins: &HashMap<String, ToolSpec>,
) -> Option<Scenario> {
    let spec = plugins.get(&q.tool)?.clone();
    Some(Scenario {
        id: format!("metatool-st-{}", q.line),
        prompt: q.query.clone(),
        candidate_pool: vec![spec],
        gold_tools: vec![q.tool.clone()],
        judge_criteria: None,
        category: Some("metatool-single".into()),
    })
}

fn build_multi_scenario(
    q: &RawMultiQuery,
    plugins: &HashMap<String, ToolSpec>,
) -> Option<Scenario> {
    let mut pool = Vec::with_capacity(q.tools.len());
    for name in &q.tools {
        pool.push(plugins.get(name)?.clone());
    }
    Some(Scenario {
        id: format!("metatool-mt-{}", q.index),
        prompt: q.query.clone(),
        candidate_pool: pool,
        gold_tools: q.tools.clone(),
        judge_criteria: None,
        category: Some("metatool-multi".into()),
    })
}

fn build_scenarios(
    single: &[RawSingleQuery],
    multi: &[RawMultiQuery],
    plugins: &HashMap<String, ToolSpec>,
) -> (Vec<Scenario>, IngestStats) {
    let mut stats = IngestStats {
        single_tool_in: single.len(),
        multi_tool_in: multi.len(),
        ..Default::default()
    };

    let mut out: Vec<Scenario> = Vec::with_capacity(single.len() + multi.len());
    for q in single {
        match build_single_scenario(q, plugins) {
            Some(s) => out.push(s),
            None => stats.skipped_unknown_gold += 1,
        }
    }
    for q in multi {
        match build_multi_scenario(q, plugins) {
            Some(s) => out.push(s),
            None => stats.skipped_unknown_gold += 1,
        }
    }

    // Stable id-sorted output keeps re-ingest diffs readable.
    out.sort_by(|a, b| a.id.cmp(&b.id));

    stats.scenarios_out = out.len();
    (out, stats)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn under_fixtures_dir_mirrors_upstream_layout() {
        let p = MetaToolPaths::under_fixtures_dir(Path::new("/tmp/fx"));
        assert_eq!(p.plugins, PathBuf::from("/tmp/fx/dataset/plugin_des.json"));
        assert_eq!(
            p.single_tool,
            PathBuf::from("/tmp/fx/dataset/data/all_clean_data.csv")
        );
        assert_eq!(
            p.multi_tool,
            Some(PathBuf::from(
                "/tmp/fx/dataset/data/multi_tool_query_golden.json"
            ))
        );
    }

    fn fixture_plugins() -> HashMap<String, ToolSpec> {
        parse_plugin_des(
            r#"{
                "WeatherTool": "Get current weather and short-range forecasts.",
                "FinanceTool": "Real-time stock and crypto prices.",
                "NewsTool": "Latest world headlines."
            }"#,
        )
        .unwrap()
    }

    #[test]
    fn parse_plugin_des_yields_one_tool_spec_per_entry() {
        let plugins = fixture_plugins();
        assert_eq!(plugins.len(), 3);
        assert!(plugins.contains_key("WeatherTool"));
        assert!(plugins.contains_key("FinanceTool"));
        assert!(plugins.contains_key("NewsTool"));
    }

    #[test]
    fn parse_plugin_des_uses_name_as_id_and_value_as_description() {
        let plugins = fixture_plugins();
        let weather = &plugins["WeatherTool"];
        assert_eq!(weather.id, "WeatherTool");
        assert_eq!(weather.name, "WeatherTool");
        assert_eq!(
            weather.description,
            "Get current weather and short-range forecasts."
        );
    }

    #[test]
    fn parse_plugin_des_yields_empty_schemas() {
        let plugins = fixture_plugins();
        let weather = &plugins["WeatherTool"];
        assert_eq!(weather.input_schema, Value::Object(Default::default()));
        assert_eq!(weather.output_schema, Value::Object(Default::default()));
    }

    #[test]
    fn parse_plugin_des_trims_whitespace_in_descriptions() {
        let plugins = parse_plugin_des(r#"{ "X": "  padded   " }"#).unwrap();
        assert_eq!(plugins["X"].description, "padded");
    }

    #[test]
    fn parse_single_tool_csv_skips_header_and_returns_data_rows() {
        let csv = "Query,Tool\nWhat's the forecast?,WeatherTool\nAAPL price?,FinanceTool\n";
        let rows = parse_single_tool_csv(csv.as_bytes()).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].query, "What's the forecast?");
        assert_eq!(rows[0].tool, "WeatherTool");
        assert_eq!(rows[1].tool, "FinanceTool");
    }

    #[test]
    fn parse_single_tool_csv_uses_one_indexed_line_numbers() {
        // First data row sits on line 2 (line 1 is the header).
        let csv = "Query,Tool\nWhat's the forecast?,WeatherTool\nAAPL price?,FinanceTool\n";
        let rows = parse_single_tool_csv(csv.as_bytes()).unwrap();
        assert_eq!(rows[0].line, 2);
        assert_eq!(rows[1].line, 3);
    }

    #[test]
    fn parse_single_tool_csv_handles_quoted_fields_with_commas() {
        let csv = "Query,Tool\n\"Summarize today, please\",NewsTool\n";
        let rows = parse_single_tool_csv(csv.as_bytes()).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].query, "Summarize today, please");
        assert_eq!(rows[0].tool, "NewsTool");
    }

    #[test]
    fn parse_multi_tool_json_reads_array_of_records() {
        let json = r#"[
            { "query": "tesla news + stock", "tool": ["NewsTool", "FinanceTool"] },
            { "query": "weather + headlines", "tool": ["WeatherTool", "NewsTool"] }
        ]"#;
        let rows = parse_multi_tool_json(json).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].index, 0);
        assert_eq!(rows[0].tools, vec!["NewsTool", "FinanceTool"]);
        assert_eq!(rows[1].index, 1);
    }

    #[test]
    fn build_single_scenario_id_uses_csv_line_number() {
        let plugins = fixture_plugins();
        let q = RawSingleQuery {
            line: 42,
            query: "What's the forecast?".into(),
            tool: "WeatherTool".into(),
        };
        let s = build_single_scenario(&q, &plugins).unwrap();
        assert_eq!(s.id, "metatool-st-42");
        assert_eq!(s.prompt, "What's the forecast?");
        assert_eq!(s.gold_tools, vec!["WeatherTool".to_string()]);
    }

    #[test]
    fn build_single_scenario_candidate_pool_carries_only_gold() {
        let plugins = fixture_plugins();
        let q = RawSingleQuery {
            line: 2,
            query: "x".into(),
            tool: "WeatherTool".into(),
        };
        let s = build_single_scenario(&q, &plugins).unwrap();
        assert_eq!(s.candidate_pool.len(), 1);
        assert_eq!(s.candidate_pool[0].id, "WeatherTool");
    }

    #[test]
    fn build_single_scenario_drops_unknown_gold() {
        let plugins = fixture_plugins();
        let q = RawSingleQuery {
            line: 2,
            query: "x".into(),
            tool: "DoesNotExist".into(),
        };
        assert!(build_single_scenario(&q, &plugins).is_none());
    }

    #[test]
    fn build_multi_scenario_collects_all_gold_tools() {
        let plugins = fixture_plugins();
        let q = RawMultiQuery {
            index: 0,
            query: "tesla + news".into(),
            tools: vec!["NewsTool".into(), "FinanceTool".into()],
        };
        let s = build_multi_scenario(&q, &plugins).unwrap();
        assert_eq!(s.id, "metatool-mt-0");
        assert_eq!(
            s.gold_tools,
            vec!["NewsTool".to_string(), "FinanceTool".to_string()]
        );
        assert_eq!(s.candidate_pool.len(), 2);
    }

    #[test]
    fn build_multi_scenario_drops_when_any_gold_unknown() {
        let plugins = fixture_plugins();
        let q = RawMultiQuery {
            index: 0,
            query: "x".into(),
            tools: vec!["NewsTool".into(), "Bogus".into()],
        };
        assert!(build_multi_scenario(&q, &plugins).is_none());
    }

    #[test]
    fn build_scenarios_keeps_every_known_gold_query() {
        let plugins = fixture_plugins();
        let single: Vec<RawSingleQuery> = (0..50)
            .map(|i| RawSingleQuery {
                line: i + 2,
                query: format!("q{i}"),
                tool: "WeatherTool".into(),
            })
            .collect();
        let multi: Vec<RawMultiQuery> = (0..7)
            .map(|i| RawMultiQuery {
                index: i,
                query: format!("m{i}"),
                tools: vec!["NewsTool".into(), "FinanceTool".into()],
            })
            .collect();
        let (out, stats) = build_scenarios(&single, &multi, &plugins);
        assert_eq!(out.len(), 57);
        assert_eq!(stats.scenarios_out, 57);
        assert_eq!(stats.single_tool_in, 50);
        assert_eq!(stats.multi_tool_in, 7);
    }

    #[test]
    fn build_scenarios_counts_skipped_unknown_gold() {
        let plugins = fixture_plugins();
        let single = vec![
            RawSingleQuery {
                line: 2,
                query: "good".into(),
                tool: "WeatherTool".into(),
            },
            RawSingleQuery {
                line: 3,
                query: "bad".into(),
                tool: "DoesNotExist".into(),
            },
        ];
        let multi = vec![RawMultiQuery {
            index: 0,
            query: "bad".into(),
            tools: vec!["NewsTool".into(), "Bogus".into()],
        }];
        let (out, stats) = build_scenarios(&single, &multi, &plugins);
        assert_eq!(out.len(), 1);
        assert_eq!(stats.skipped_unknown_gold, 2);
    }

    #[test]
    fn build_scenarios_emits_stable_id_sorted_output() {
        let plugins = fixture_plugins();
        let single: Vec<RawSingleQuery> = (0..5)
            .map(|i| RawSingleQuery {
                line: i + 2,
                query: format!("q{i}"),
                tool: "WeatherTool".into(),
            })
            .collect();
        let (out, _) = build_scenarios(&single, &[], &plugins);
        let ids: Vec<&String> = out.iter().map(|s| &s.id).collect();
        let mut sorted = ids.clone();
        sorted.sort();
        assert_eq!(ids, sorted);
    }
}
