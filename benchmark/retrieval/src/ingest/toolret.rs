//! ToolRet → normalized [`crate::corpus::Scenario`] JSONL adapter.
//!
//! Source: <https://huggingface.co/datasets/mangopy/ToolRet-Tools> +
//! <https://huggingface.co/datasets/mangopy/ToolRet-Queries> (Apache-2.0).
//!
//! Upstream layout (parquet, auto-converted by HF):
//! - `ToolRet-Tools` — 3 subsets (`code`, `customized`, `web`), one parquet
//!   each. Two columns per row: `id` (string), `documentation` (JSON-encoded
//!   string).
//! - `ToolRet-Queries` — 35 sub-corpora, one parquet each, single split
//!   `queries`. Five columns: `id`, `query`, `instruction`, `labels`
//!   (JSON-encoded string of `[{id, doc, relevance}]`), `category`.
//!
//! Mapping rules (per ADR-0006 mode b + decisions in the v0.1.1 plan):
//! - Tool universe = union of the three `ToolRet-Tools` subsets, deduped on `id`.
//!   `ToolSpec.id` = upstream `id`. `name`/`description`/`input_schema` are
//!   derived from the parsed `documentation` JSON; `output_schema` is `{}`.
//! - Each upstream query → one [`Scenario`]. `prompt` = `instruction` with the
//!   "Given a … task, retrieve tools that …" wrapper stripped (uniform-noise
//!   reduction; identity fallback when the wrapper is absent).
//! - `gold_tools` = `labels[].id where relevance == 1`.
//! - `candidate_pool` carries only gold tool(s); the runner pools distractors
//!   across scenarios at retrieval time (mirrors MetaTool's convention).
//! - Scenario id `toolret-<subset_slug>-<index>`. `subset_slug` is derived from
//!   `category` (lowercased, `_query` stripped) so the prefix is recognized by
//!   `report.ts`'s `corpusOf()`.
//! - Queries whose gold tool(s) are not in the tool map are skipped (counted).

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, anyhow};
use parquet::file::reader::{FileReader, SerializedFileReader};
use parquet::record::RowAccessor;
use serde::Deserialize;
use serde_json::Value;

use crate::corpus::{Scenario, ToolSpec};

/// Canonical HuggingFace parquet URLs for the three ToolRet-Tools subsets.
///
/// Pinned here so the CLI's `--download` path and `benchmark/test-data/SOURCES.md`
/// share one source of truth. (subset, url).
pub const TOOLS_URLS: &[(&str, &str)] = &[
    (
        "code",
        "https://huggingface.co/api/datasets/mangopy/ToolRet-Tools/parquet/code/tools/0.parquet",
    ),
    (
        "customized",
        "https://huggingface.co/api/datasets/mangopy/ToolRet-Tools/parquet/customized/tools/0.parquet",
    ),
    (
        "web",
        "https://huggingface.co/api/datasets/mangopy/ToolRet-Tools/parquet/web/tools/0.parquet",
    ),
];

/// Canonical HuggingFace parquet URLs for the 35 ToolRet-Queries sub-corpora.
pub const QUERIES_URLS: &[(&str, &str)] = &[
    (
        "apibank",
        "https://huggingface.co/api/datasets/mangopy/ToolRet-Queries/parquet/apibank/queries/0.parquet",
    ),
    (
        "apigen",
        "https://huggingface.co/api/datasets/mangopy/ToolRet-Queries/parquet/apigen/queries/0.parquet",
    ),
    (
        "appbench",
        "https://huggingface.co/api/datasets/mangopy/ToolRet-Queries/parquet/appbench/queries/0.parquet",
    ),
    (
        "autotools-food",
        "https://huggingface.co/api/datasets/mangopy/ToolRet-Queries/parquet/autotools-food/queries/0.parquet",
    ),
    (
        "autotools-music",
        "https://huggingface.co/api/datasets/mangopy/ToolRet-Queries/parquet/autotools-music/queries/0.parquet",
    ),
    (
        "autotools-weather",
        "https://huggingface.co/api/datasets/mangopy/ToolRet-Queries/parquet/autotools-weather/queries/0.parquet",
    ),
    (
        "craft-math-algebra",
        "https://huggingface.co/api/datasets/mangopy/ToolRet-Queries/parquet/craft-math-algebra/queries/0.parquet",
    ),
    (
        "craft-tabmwp",
        "https://huggingface.co/api/datasets/mangopy/ToolRet-Queries/parquet/craft-tabmwp/queries/0.parquet",
    ),
    (
        "craft-vqa",
        "https://huggingface.co/api/datasets/mangopy/ToolRet-Queries/parquet/craft-vqa/queries/0.parquet",
    ),
    (
        "gorilla-huggingface",
        "https://huggingface.co/api/datasets/mangopy/ToolRet-Queries/parquet/gorilla-huggingface/queries/0.parquet",
    ),
    (
        "gorilla-pytorch",
        "https://huggingface.co/api/datasets/mangopy/ToolRet-Queries/parquet/gorilla-pytorch/queries/0.parquet",
    ),
    (
        "gorilla-tensor",
        "https://huggingface.co/api/datasets/mangopy/ToolRet-Queries/parquet/gorilla-tensor/queries/0.parquet",
    ),
    (
        "gpt4tools",
        "https://huggingface.co/api/datasets/mangopy/ToolRet-Queries/parquet/gpt4tools/queries/0.parquet",
    ),
    (
        "gta",
        "https://huggingface.co/api/datasets/mangopy/ToolRet-Queries/parquet/gta/queries/0.parquet",
    ),
    (
        "metatool",
        "https://huggingface.co/api/datasets/mangopy/ToolRet-Queries/parquet/metatool/queries/0.parquet",
    ),
    (
        "mnms",
        "https://huggingface.co/api/datasets/mangopy/ToolRet-Queries/parquet/mnms/queries/0.parquet",
    ),
    (
        "restgpt-spotify",
        "https://huggingface.co/api/datasets/mangopy/ToolRet-Queries/parquet/restgpt-spotify/queries/0.parquet",
    ),
    (
        "restgpt-tmdb",
        "https://huggingface.co/api/datasets/mangopy/ToolRet-Queries/parquet/restgpt-tmdb/queries/0.parquet",
    ),
    (
        "reversechain",
        "https://huggingface.co/api/datasets/mangopy/ToolRet-Queries/parquet/reversechain/queries/0.parquet",
    ),
    (
        "rotbench",
        "https://huggingface.co/api/datasets/mangopy/ToolRet-Queries/parquet/rotbench/queries/0.parquet",
    ),
    (
        "t-eval-dialog",
        "https://huggingface.co/api/datasets/mangopy/ToolRet-Queries/parquet/t-eval-dialog/queries/0.parquet",
    ),
    (
        "t-eval-step",
        "https://huggingface.co/api/datasets/mangopy/ToolRet-Queries/parquet/t-eval-step/queries/0.parquet",
    ),
    (
        "taskbench-daily",
        "https://huggingface.co/api/datasets/mangopy/ToolRet-Queries/parquet/taskbench-daily/queries/0.parquet",
    ),
    (
        "taskbench-huggingface",
        "https://huggingface.co/api/datasets/mangopy/ToolRet-Queries/parquet/taskbench-huggingface/queries/0.parquet",
    ),
    (
        "taskbench-multimedia",
        "https://huggingface.co/api/datasets/mangopy/ToolRet-Queries/parquet/taskbench-multimedia/queries/0.parquet",
    ),
    (
        "tool-be-honest",
        "https://huggingface.co/api/datasets/mangopy/ToolRet-Queries/parquet/tool-be-honest/queries/0.parquet",
    ),
    (
        "toolace",
        "https://huggingface.co/api/datasets/mangopy/ToolRet-Queries/parquet/toolace/queries/0.parquet",
    ),
    (
        "toolalpaca",
        "https://huggingface.co/api/datasets/mangopy/ToolRet-Queries/parquet/toolalpaca/queries/0.parquet",
    ),
    (
        "toolbench",
        "https://huggingface.co/api/datasets/mangopy/ToolRet-Queries/parquet/toolbench/queries/0.parquet",
    ),
    (
        "toolbench-sam",
        "https://huggingface.co/api/datasets/mangopy/ToolRet-Queries/parquet/toolbench-sam/queries/0.parquet",
    ),
    (
        "toolemu",
        "https://huggingface.co/api/datasets/mangopy/ToolRet-Queries/parquet/toolemu/queries/0.parquet",
    ),
    (
        "tooleyes",
        "https://huggingface.co/api/datasets/mangopy/ToolRet-Queries/parquet/tooleyes/queries/0.parquet",
    ),
    (
        "toolink",
        "https://huggingface.co/api/datasets/mangopy/ToolRet-Queries/parquet/toolink/queries/0.parquet",
    ),
    (
        "toollens",
        "https://huggingface.co/api/datasets/mangopy/ToolRet-Queries/parquet/toollens/queries/0.parquet",
    ),
    (
        "ultratool",
        "https://huggingface.co/api/datasets/mangopy/ToolRet-Queries/parquet/ultratool/queries/0.parquet",
    ),
];

/// Local paths to the upstream ToolRet parquet files, mirroring the upstream
/// subset layout under a fixtures directory.
#[derive(Debug, Clone)]
pub struct ToolRetPaths {
    /// One entry per `TOOLS_URLS` subset (subset name preserved for diagnostics).
    pub tools: Vec<(String, PathBuf)>,
    /// One entry per `QUERIES_URLS` subset.
    pub queries: Vec<(String, PathBuf)>,
}

impl ToolRetPaths {
    /// Default layout under a fixtures directory:
    /// `<dir>/tools/<subset>.parquet`, `<dir>/queries/<subset>.parquet`.
    pub fn under_fixtures_dir(fixtures_dir: &Path) -> Self {
        let tools = TOOLS_URLS
            .iter()
            .map(|(subset, _)| {
                (
                    (*subset).to_string(),
                    fixtures_dir.join("tools").join(format!("{subset}.parquet")),
                )
            })
            .collect();
        let queries = QUERIES_URLS
            .iter()
            .map(|(subset, _)| {
                (
                    (*subset).to_string(),
                    fixtures_dir
                        .join("queries")
                        .join(format!("{subset}.parquet")),
                )
            })
            .collect();
        Self { tools, queries }
    }
}

/// Counters for one ingestion run.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct IngestStats {
    pub tools_loaded: usize,
    pub queries_in: usize,
    pub scenarios_out: usize,
    pub skipped_unknown_gold: usize,
    pub skipped_no_positive_label: usize,
}

/// One row from a tools parquet, before flattening.
#[derive(Debug, Clone, PartialEq)]
struct RawTool {
    id: String,
    /// JSON-encoded documentation blob (varies by subset shape).
    documentation: String,
}

/// One row from a queries parquet, before scenario construction.
#[derive(Debug, Clone, PartialEq)]
struct RawQuery {
    /// 0-indexed position within the subset's parquet file. Used for stable IDs.
    index: usize,
    /// Upstream sub-corpus name (e.g. `apibank`, `craft-math-algebra`).
    subset: String,
    upstream_id: String,
    instruction: String,
    /// JSON-encoded `labels` array.
    labels_json: String,
    /// Upstream `category` field, preserved verbatim on `Scenario.category`.
    category: String,
}

/// One label inside a query's `labels[]` array, after JSON parsing.
#[derive(Debug, Clone, PartialEq, Deserialize)]
struct RawLabel {
    id: String,
    /// Optional in the upstream JSON; absent ≡ relevant (the apibank sample we
    /// inspected ships labels without an explicit `relevance` field, all of
    /// which represent positive matches).
    #[serde(default = "default_relevance")]
    relevance: i64,
}

fn default_relevance() -> i64 {
    1
}

/// Strip the IR-style `Given a … task, retrieve tools that …` wrapper from
/// ToolRet's `instruction` field. Identity fallback when the wrapper is absent.
///
/// The wrapper is uniform across the dataset and adds the same noise to every
/// arm's BM25 input — stripping it doesn't bias the comparison, it just gives
/// the index a cleaner query-noun-phrase to score against.
pub(crate) fn strip_ir_wrapper(instruction: &str) -> String {
    const PREFIX: &str = "Given a ";
    const MIDDLE: &str = " task, retrieve tools that ";
    let trimmed = instruction.trim();
    if let Some(rest) = trimmed.strip_prefix(PREFIX)
        && let Some(idx) = rest.find(MIDDLE)
    {
        let tail = &rest[idx + MIDDLE.len()..];
        return tail.trim().trim_end_matches('.').trim().to_string();
    }
    trimmed.to_string()
}

/// Slug-ify a category label for inclusion in scenario IDs. Lowercases and
/// strips a trailing `_query` (so `apibank_query` → `apibank`).
pub(crate) fn slug_for_id(category: &str) -> String {
    let lower = category.trim().to_lowercase();
    lower
        .strip_suffix("_query")
        .map(|s| s.to_string())
        .unwrap_or(lower)
}

/// Flatten a parsed `documentation` JSON value into a [`ToolSpec`].
///
/// Strategy (must stay stable across the three subset shapes):
/// - `name` = first non-empty of `name`, `functionality`, `domain`, else id.
/// - `description` = first non-empty of `description`, `functionality`,
///   then a deterministic fallback that concatenates whatever string fields
///   exist in the doc (sorted by key for reproducibility).
/// - `input_schema` = `parameters` (verbatim) if present, else `{}`.
fn tool_spec_from_documentation(id: &str, doc_json: &str) -> ToolSpec {
    let parsed: Value = serde_json::from_str(doc_json).unwrap_or(Value::Null);
    let obj = parsed.as_object();

    let name = obj
        .and_then(|o| o.get("name").and_then(Value::as_str))
        .filter(|s| !s.is_empty())
        .or_else(|| {
            obj.and_then(|o| o.get("functionality").and_then(Value::as_str))
                .filter(|s| !s.is_empty())
        })
        .or_else(|| {
            obj.and_then(|o| o.get("domain").and_then(Value::as_str))
                .filter(|s| !s.is_empty())
        })
        .map(|s| s.to_string())
        .unwrap_or_else(|| id.to_string());

    let description = obj
        .and_then(|o| o.get("description").and_then(Value::as_str))
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or_else(|| {
            obj.and_then(|o| o.get("functionality").and_then(Value::as_str))
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| {
            // Deterministic fallback: concatenate string-typed fields in
            // sorted key order so identical inputs always produce identical
            // outputs (no HashMap iteration leakage).
            obj.map(|o| {
                let mut keys: Vec<&String> = o.keys().collect();
                keys.sort();
                keys.iter()
                    .filter_map(|k| o.get(*k).and_then(Value::as_str).map(|v| (k.as_str(), v)))
                    .filter(|(_, v)| !v.is_empty())
                    .map(|(k, v)| format!("{k}: {v}"))
                    .collect::<Vec<_>>()
                    .join(". ")
            })
            .unwrap_or_default()
        });

    let input_schema = obj
        .and_then(|o| o.get("parameters").cloned())
        .unwrap_or_else(|| Value::Object(Default::default()));

    ToolSpec {
        id: id.to_string(),
        name,
        description,
        input_schema,
        output_schema: Value::Object(Default::default()),
    }
}

fn read_parquet_string_columns(
    path: &Path,
    expected_columns: &[&str],
) -> anyhow::Result<Vec<Vec<String>>> {
    let file = File::open(path).with_context(|| format!("opening parquet {}", path.display()))?;
    let reader = SerializedFileReader::new(file)
        .with_context(|| format!("reading parquet metadata for {}", path.display()))?;
    let schema = reader.metadata().file_metadata().schema_descr();

    let mut col_indices = Vec::with_capacity(expected_columns.len());
    for &name in expected_columns {
        let idx = (0..schema.num_columns())
            .find(|i| schema.column(*i).name() == name)
            .ok_or_else(|| anyhow!("column `{name}` missing from {}", path.display()))?;
        col_indices.push(idx);
    }

    let mut out: Vec<Vec<String>> = vec![Vec::new(); expected_columns.len()];
    let row_iter = reader
        .get_row_iter(None)
        .with_context(|| format!("opening row iter for {}", path.display()))?;
    for row in row_iter {
        let row = row.with_context(|| format!("reading row from {}", path.display()))?;
        for (slot, &idx) in col_indices.iter().enumerate() {
            let s = row
                .get_string(idx)
                .with_context(|| {
                    format!(
                        "reading column `{}` from {} (expected string)",
                        expected_columns[slot],
                        path.display()
                    )
                })?
                .to_string();
            out[slot].push(s);
        }
    }
    Ok(out)
}

fn parse_tools_parquet(path: &Path) -> anyhow::Result<Vec<RawTool>> {
    let cols = read_parquet_string_columns(path, &["id", "documentation"])?;
    let ids = &cols[0];
    let docs = &cols[1];
    Ok(ids
        .iter()
        .zip(docs.iter())
        .map(|(id, doc)| RawTool {
            id: id.clone(),
            documentation: doc.clone(),
        })
        .collect())
}

fn parse_queries_parquet(path: &Path, subset: &str) -> anyhow::Result<Vec<RawQuery>> {
    let cols =
        read_parquet_string_columns(path, &["id", "query", "instruction", "labels", "category"])?;
    let n = cols[0].len();
    let mut out = Vec::with_capacity(n);
    for (i, ((upstream_id, instruction), (labels_json, category))) in cols[0]
        .iter()
        .zip(cols[2].iter())
        .zip(cols[3].iter().zip(cols[4].iter()))
        .enumerate()
    {
        out.push(RawQuery {
            index: i,
            subset: subset.to_string(),
            upstream_id: upstream_id.clone(),
            instruction: instruction.clone(),
            labels_json: labels_json.clone(),
            category: category.clone(),
        });
    }
    Ok(out)
}

fn parse_labels(labels_json: &str) -> anyhow::Result<Vec<RawLabel>> {
    serde_json::from_str(labels_json).context("parsing labels JSON")
}

fn build_scenarios(
    queries: &[RawQuery],
    tools: &HashMap<String, ToolSpec>,
) -> (Vec<Scenario>, IngestStats) {
    let mut stats = IngestStats {
        tools_loaded: tools.len(),
        queries_in: queries.len(),
        ..Default::default()
    };
    let mut out = Vec::with_capacity(queries.len());

    for q in queries {
        let labels = match parse_labels(&q.labels_json) {
            Ok(l) => l,
            Err(_) => {
                stats.skipped_unknown_gold += 1;
                continue;
            }
        };
        let gold_ids: Vec<String> = labels
            .iter()
            .filter(|l| l.relevance == 1)
            .map(|l| l.id.clone())
            .collect();
        if gold_ids.is_empty() {
            stats.skipped_no_positive_label += 1;
            continue;
        }
        let mut pool = Vec::with_capacity(gold_ids.len());
        let mut all_known = true;
        for gid in &gold_ids {
            match tools.get(gid) {
                Some(spec) => pool.push(spec.clone()),
                None => {
                    all_known = false;
                    break;
                }
            }
        }
        if !all_known {
            stats.skipped_unknown_gold += 1;
            continue;
        }
        let prompt = strip_ir_wrapper(&q.instruction);
        if prompt.is_empty() {
            stats.skipped_unknown_gold += 1;
            continue;
        }
        let id = format!("toolret-{}-{}", slug_for_id(&q.subset), q.index);
        out.push(Scenario {
            id,
            prompt,
            candidate_pool: pool,
            gold_tools: gold_ids,
            judge_criteria: None,
            category: Some(q.category.clone()),
        });
    }

    out.sort_by(|a, b| a.id.cmp(&b.id));
    stats.scenarios_out = out.len();
    (out, stats)
}

/// Read ToolRet inputs and write a normalized JSONL to `output`.
pub fn ingest_to_jsonl(paths: &ToolRetPaths, output: &Path) -> anyhow::Result<IngestStats> {
    let mut tools: HashMap<String, ToolSpec> = HashMap::new();
    for (subset, path) in &paths.tools {
        let raw = parse_tools_parquet(path)
            .with_context(|| format!("parsing tools parquet for subset `{subset}`"))?;
        for r in raw {
            // Last writer wins on duplicate ids — they shouldn't exist across
            // ToolRet's three subsets per the published 44k count.
            tools.insert(
                r.id.clone(),
                tool_spec_from_documentation(&r.id, &r.documentation),
            );
        }
    }

    let mut queries: Vec<RawQuery> = Vec::new();
    for (subset, path) in &paths.queries {
        let raw = parse_queries_parquet(path, subset)
            .with_context(|| format!("parsing queries parquet for subset `{subset}`"))?;
        queries.extend(raw);
    }

    let (scenarios, stats) = build_scenarios(&queries, &tools);

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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ----------------------- strip_ir_wrapper -----------------------

    #[test]
    fn strip_ir_wrapper_extracts_tail_after_marker() {
        let s = "Given a `bacterial growth` task, retrieve tools that compute exponential growth from initial count, rate, and elapsed time.";
        assert_eq!(
            strip_ir_wrapper(s),
            "compute exponential growth from initial count, rate, and elapsed time"
        );
    }

    #[test]
    fn strip_ir_wrapper_is_identity_when_marker_absent() {
        let s = "What is the bacterial population after 4 hours?";
        assert_eq!(strip_ir_wrapper(s), s);
    }

    #[test]
    fn strip_ir_wrapper_trims_whitespace_and_trailing_period() {
        let s = "  Given a query task, retrieve tools that fetch news.   ";
        assert_eq!(strip_ir_wrapper(s), "fetch news");
    }

    // ----------------------- slug_for_id -----------------------

    #[test]
    fn slug_for_id_strips_query_suffix_and_lowercases() {
        assert_eq!(slug_for_id("apibank_query"), "apibank");
        assert_eq!(slug_for_id("Toolbench-SAM"), "toolbench-sam");
        assert_eq!(slug_for_id("metatool"), "metatool");
    }

    // ----------------------- tool_spec_from_documentation -----------------------

    #[test]
    fn tool_spec_uses_name_and_description_when_present() {
        let doc = json!({
            "name": "BacterialGrowth",
            "description": "Predict bacterial population at time t.",
            "parameters": { "initial": "int", "rate": "float", "time": "float" }
        })
        .to_string();
        let spec = tool_spec_from_documentation("apigen_tool_272", &doc);
        assert_eq!(spec.id, "apigen_tool_272");
        assert_eq!(spec.name, "BacterialGrowth");
        assert_eq!(spec.description, "Predict bacterial population at time t.");
        assert_eq!(
            spec.input_schema,
            json!({ "initial": "int", "rate": "float", "time": "float" })
        );
        assert_eq!(spec.output_schema, json!({}));
    }

    #[test]
    fn tool_spec_falls_back_to_functionality_for_description() {
        // gorilla-style row: no `description`, but a `functionality` blurb.
        let doc = json!({
            "domain": "Image object detection",
            "framework": "TensorFlow Hub",
            "functionality": "Detect objects in images",
            "api_call": "hub.load('https://tfhub.dev/...')"
        })
        .to_string();
        let spec = tool_spec_from_documentation("gorilla_tensor_tool_0", &doc);
        assert_eq!(spec.description, "Detect objects in images");
    }

    #[test]
    fn tool_spec_concatenates_keys_when_no_description_or_functionality() {
        let doc = json!({
            "domain": "X",
            "api_call": "Y"
        })
        .to_string();
        let spec = tool_spec_from_documentation("x", &doc);
        // Sorted key order ensures determinism.
        assert_eq!(spec.description, "api_call: Y. domain: X");
    }

    #[test]
    fn tool_spec_uses_id_as_name_when_no_named_field() {
        let doc = json!({ "description": "x" }).to_string();
        let spec = tool_spec_from_documentation("apibank_tool_42", &doc);
        assert_eq!(spec.name, "apibank_tool_42");
    }

    #[test]
    fn tool_spec_handles_invalid_json_gracefully() {
        let spec = tool_spec_from_documentation("bad", "not json");
        assert_eq!(spec.id, "bad");
        assert_eq!(spec.name, "bad");
        assert_eq!(spec.description, "");
        assert_eq!(spec.input_schema, json!({}));
    }

    // ----------------------- parse_labels -----------------------

    #[test]
    fn parse_labels_reads_explicit_relevance() {
        let json = r#"[{"id":"t1","relevance":1},{"id":"t2","relevance":0}]"#;
        let labels = parse_labels(json).unwrap();
        assert_eq!(labels.len(), 2);
        assert_eq!(labels[0].id, "t1");
        assert_eq!(labels[0].relevance, 1);
        assert_eq!(labels[1].relevance, 0);
    }

    #[test]
    fn parse_labels_defaults_relevance_to_one_when_absent() {
        // apibank-style sample omits `relevance`; treat as positive.
        let json = r#"[{"id":"apibank_tool_33","doc":{"name":"X"}}]"#;
        let labels = parse_labels(json).unwrap();
        assert_eq!(labels.len(), 1);
        assert_eq!(labels[0].relevance, 1);
    }

    // ----------------------- build_scenarios -----------------------

    fn fixture_tools() -> HashMap<String, ToolSpec> {
        let mut m = HashMap::new();
        m.insert(
            "tool_a".into(),
            ToolSpec {
                id: "tool_a".into(),
                name: "A".into(),
                description: "Alpha tool".into(),
                input_schema: json!({}),
                output_schema: json!({}),
            },
        );
        m.insert(
            "tool_b".into(),
            ToolSpec {
                id: "tool_b".into(),
                name: "B".into(),
                description: "Beta tool".into(),
                input_schema: json!({}),
                output_schema: json!({}),
            },
        );
        m
    }

    fn raw_query(
        index: usize,
        subset: &str,
        instruction: &str,
        labels_json: &str,
        category: &str,
    ) -> RawQuery {
        RawQuery {
            index,
            subset: subset.into(),
            upstream_id: format!("{subset}_query_{index}"),
            instruction: instruction.into(),
            labels_json: labels_json.into(),
            category: category.into(),
        }
    }

    #[test]
    fn build_scenarios_id_uses_subset_slug_and_index() {
        let tools = fixture_tools();
        let queries = vec![raw_query(
            0,
            "apibank",
            "Given a t task, retrieve tools that do alpha.",
            r#"[{"id":"tool_a"}]"#,
            "apibank_query",
        )];
        let (out, _) = build_scenarios(&queries, &tools);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, "toolret-apibank-0");
        assert_eq!(out[0].prompt, "do alpha");
        assert_eq!(out[0].gold_tools, vec!["tool_a"]);
        assert_eq!(out[0].candidate_pool.len(), 1);
        assert_eq!(out[0].candidate_pool[0].id, "tool_a");
        assert_eq!(out[0].category.as_deref(), Some("apibank_query"));
    }

    #[test]
    fn build_scenarios_collects_only_positive_labels() {
        let tools = fixture_tools();
        let queries = vec![raw_query(
            1,
            "x",
            "Given a t task, retrieve tools that do mixed.",
            r#"[{"id":"tool_a","relevance":1},{"id":"tool_b","relevance":0}]"#,
            "x",
        )];
        let (out, _) = build_scenarios(&queries, &tools);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].gold_tools, vec!["tool_a"]);
    }

    #[test]
    fn build_scenarios_skips_unknown_gold_and_counts() {
        let tools = fixture_tools();
        let queries = vec![raw_query(
            2,
            "x",
            "Given a t task, retrieve tools that do something.",
            r#"[{"id":"missing_tool","relevance":1}]"#,
            "x",
        )];
        let (out, stats) = build_scenarios(&queries, &tools);
        assert!(out.is_empty());
        assert_eq!(stats.skipped_unknown_gold, 1);
    }

    #[test]
    fn build_scenarios_skips_when_no_positive_label() {
        let tools = fixture_tools();
        let queries = vec![raw_query(
            3,
            "x",
            "Given a t task, retrieve tools that do nothing.",
            r#"[{"id":"tool_a","relevance":0}]"#,
            "x",
        )];
        let (out, stats) = build_scenarios(&queries, &tools);
        assert!(out.is_empty());
        assert_eq!(stats.skipped_no_positive_label, 1);
    }

    #[test]
    fn build_scenarios_handles_multi_positive_labels() {
        let tools = fixture_tools();
        let queries = vec![raw_query(
            4,
            "x",
            "Given a t task, retrieve tools that combine alpha and beta.",
            r#"[{"id":"tool_a","relevance":1},{"id":"tool_b","relevance":1}]"#,
            "x",
        )];
        let (out, _) = build_scenarios(&queries, &tools);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].gold_tools, vec!["tool_a", "tool_b"]);
        assert_eq!(out[0].candidate_pool.len(), 2);
    }

    #[test]
    fn build_scenarios_emits_id_sorted_output() {
        let tools = fixture_tools();
        let queries = vec![
            raw_query(
                0,
                "z",
                "Given a t task, retrieve tools that z.",
                r#"[{"id":"tool_a"}]"#,
                "z",
            ),
            raw_query(
                0,
                "a",
                "Given a t task, retrieve tools that a.",
                r#"[{"id":"tool_a"}]"#,
                "a",
            ),
            raw_query(
                0,
                "m",
                "Given a t task, retrieve tools that m.",
                r#"[{"id":"tool_a"}]"#,
                "m",
            ),
        ];
        let (out, _) = build_scenarios(&queries, &tools);
        let ids: Vec<&str> = out.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["toolret-a-0", "toolret-m-0", "toolret-z-0"]);
    }

    #[test]
    fn build_scenarios_stats_counts_inputs_and_outputs() {
        let tools = fixture_tools();
        let queries = vec![
            raw_query(
                0,
                "x",
                "Given a t task, retrieve tools that ok.",
                r#"[{"id":"tool_a"}]"#,
                "x",
            ),
            raw_query(
                1,
                "x",
                "Given a t task, retrieve tools that bad.",
                r#"[{"id":"missing"}]"#,
                "x",
            ),
        ];
        let (out, stats) = build_scenarios(&queries, &tools);
        assert_eq!(stats.queries_in, 2);
        assert_eq!(stats.tools_loaded, tools.len());
        assert_eq!(stats.scenarios_out, 1);
        assert_eq!(stats.skipped_unknown_gold, 1);
        assert_eq!(out.len(), 1);
    }

    // ----------------------- under_fixtures_dir -----------------------

    #[test]
    fn under_fixtures_dir_lays_out_subset_paths() {
        let p = ToolRetPaths::under_fixtures_dir(Path::new("/tmp/fx"));
        assert_eq!(p.tools.len(), TOOLS_URLS.len());
        assert_eq!(p.queries.len(), QUERIES_URLS.len());
        let (subset, path) = &p.tools[0];
        assert_eq!(subset, "code");
        assert_eq!(path, &PathBuf::from("/tmp/fx/tools/code.parquet"));
        let apibank = p.queries.iter().find(|(s, _)| s == "apibank").unwrap();
        assert_eq!(apibank.1, PathBuf::from("/tmp/fx/queries/apibank.parquet"));
    }
}
