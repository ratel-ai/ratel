//! Drives retrieval-only metrics across every scenario in a corpus.
//!
//! For each scenario, evaluates BM25 quality at each requested catalog scale,
//! using tools from other scenarios as distractors. Emits one JSONL row per
//! `(scenario, pool_size)` cell.

use std::collections::HashSet;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::PathBuf;

use rand::SeedableRng;
use rand::seq::SliceRandom;
use serde::Serialize;

use crate::corpus::{Scenario, ToolSpec, load_scenarios};
use crate::retrieval::{RetrievalMetrics, build_pool, evaluate_at_ks};

/// Inputs for one retrieval-only run.
#[derive(Debug, Clone)]
pub struct RunConfig {
    pub corpus_path: PathBuf,
    pub output_path: PathBuf,
    pub scenario_limit: Option<usize>,
    /// K cutoffs to score at, in the order the runner should emit them.
    /// Each `(scenario, pool_size)` cell produces one JSONL row per K.
    pub top_ks: Vec<usize>,
    pub pool_sizes: Vec<usize>,
    pub seed: u64,
}

/// One row of retrieval-only output. Joined to agent-loop rows by `scenario_id`.
#[derive(Debug, Clone, Serialize)]
pub struct RetrievalRow {
    pub scenario_id: String,
    pub target_pool_size: usize,
    pub actual_pool_size: usize,
    #[serde(flatten)]
    pub metrics: RetrievalMetrics,
}

pub fn run_retrieval(config: &RunConfig) -> anyhow::Result<RunSummary> {
    let scenarios = load_scenarios(&config.corpus_path)?;
    let scenarios: Vec<Scenario> = match config.scenario_limit {
        Some(n) => scenarios.into_iter().take(n).collect(),
        None => scenarios,
    };

    if let Some(parent) = config.output_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| anyhow::anyhow!("creating output dir {}: {e}", parent.display()))?;
    }
    let file = File::create(&config.output_path)
        .map_err(|e| anyhow::anyhow!("creating {}: {e}", config.output_path.display()))?;
    let mut writer = BufWriter::new(file);

    let global_distractors = collect_global_distractors(&scenarios);
    let mut rows = 0usize;

    for scenario in &scenarios {
        let scenario_ids: HashSet<&String> =
            scenario.candidate_pool.iter().map(|t| &t.id).collect();
        let mut distractors: Vec<ToolSpec> = global_distractors
            .iter()
            .filter(|t| !scenario_ids.contains(&t.id))
            .cloned()
            .collect();

        // Per-scenario shuffle for deterministic-but-varied distractor ordering.
        let mut rng = scenario_rng(&scenario.id, config.seed);
        distractors.shuffle(&mut rng);

        for &target_size in &config.pool_sizes {
            let pool = build_pool(&scenario.candidate_pool, &distractors, target_size);
            let all_metrics = evaluate_at_ks(
                &pool,
                &scenario.prompt,
                &scenario.gold_tools,
                &config.top_ks,
            );
            for metrics in all_metrics {
                let row = RetrievalRow {
                    scenario_id: scenario.id.clone(),
                    target_pool_size: target_size,
                    actual_pool_size: pool.len(),
                    metrics,
                };
                writeln!(writer, "{}", serde_json::to_string(&row)?)?;
                rows += 1;
            }
        }
    }

    writer.flush()?;
    Ok(RunSummary {
        scenarios: scenarios.len(),
        rows_written: rows,
    })
}

#[derive(Debug, Clone, PartialEq)]
pub struct RunSummary {
    pub scenarios: usize,
    pub rows_written: usize,
}

/// Pool every tool from every scenario into a global distractor list. Each
/// scenario filters out tools that are already in its own candidate pool.
fn collect_global_distractors(scenarios: &[Scenario]) -> Vec<ToolSpec> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<ToolSpec> = Vec::new();
    for s in scenarios {
        for t in &s.candidate_pool {
            if seen.insert(t.id.clone()) {
                out.push(t.clone());
            }
        }
    }
    out
}

fn scenario_rng(scenario_id: &str, seed: u64) -> rand::rngs::StdRng {
    // Mix the scenario id into the seed so distractor orderings vary per scenario
    // but stay reproducible for the same (id, seed) pair.
    let mut h: u64 = seed;
    for b in scenario_id.bytes() {
        h = h.wrapping_mul(1099511628211).wrapping_add(b as u64);
    }
    rand::rngs::StdRng::seed_from_u64(h)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::corpus::ToolSpec;
    use serde_json::json;
    use std::io::Read;

    fn t(id: &str, desc: &str) -> ToolSpec {
        ToolSpec {
            id: id.into(),
            name: id.into(),
            description: desc.into(),
            input_schema: json!({}),
            output_schema: json!({}),
        }
    }

    fn write_corpus(scenarios: &[Scenario]) -> tempfile::NamedTempFile {
        let f = tempfile::NamedTempFile::new().unwrap();
        let mut writer = std::io::BufWriter::new(f.as_file());
        for s in scenarios {
            writeln!(writer, "{}", serde_json::to_string(s).unwrap()).unwrap();
        }
        writer.flush().unwrap();
        drop(writer);
        f
    }

    fn scenario(id: &str, prompt: &str, pool: Vec<ToolSpec>, gold: &[&str]) -> Scenario {
        Scenario {
            id: id.into(),
            prompt: prompt.into(),
            candidate_pool: pool,
            gold_tools: gold.iter().map(|s| (*s).to_string()).collect(),
            judge_criteria: None,
            category: None,
        }
    }

    #[test]
    fn run_emits_one_row_per_scenario_pool_and_k() {
        let scenarios = vec![
            scenario(
                "s1",
                "read a file from disk",
                vec![t("fs.read", "Read a file from disk.")],
                &["fs.read"],
            ),
            scenario(
                "s2",
                "send an email to a recipient",
                vec![t("mail.send", "Send an email to a recipient.")],
                &["mail.send"],
            ),
        ];
        let corpus = write_corpus(&scenarios);
        let out = tempfile::NamedTempFile::new().unwrap();
        let cfg = RunConfig {
            corpus_path: corpus.path().to_path_buf(),
            output_path: out.path().to_path_buf(),
            scenario_limit: None,
            top_ks: vec![1, 3],
            pool_sizes: vec![1, 2, 5],
            seed: 42,
        };
        let summary = run_retrieval(&cfg).unwrap();
        assert_eq!(summary.scenarios, 2);
        // 2 scenarios × 3 pool sizes × 2 K values = 12 rows.
        assert_eq!(summary.rows_written, 12);

        let mut contents = String::new();
        std::fs::File::open(out.path())
            .unwrap()
            .read_to_string(&mut contents)
            .unwrap();
        let lines: Vec<&str> = contents.lines().filter(|l| !l.is_empty()).collect();
        assert_eq!(lines.len(), 12);
        let mut ks_seen = std::collections::HashSet::new();
        for line in lines {
            let v: serde_json::Value = serde_json::from_str(line).unwrap();
            ks_seen.insert(v["k"].as_u64().unwrap() as usize);
        }
        assert_eq!(ks_seen, std::collections::HashSet::from([1, 3]));
    }

    #[test]
    fn run_respects_scenario_limit() {
        let scenarios = vec![
            scenario("s1", "p1", vec![t("a", "alpha")], &["a"]),
            scenario("s2", "p2", vec![t("b", "beta")], &["b"]),
            scenario("s3", "p3", vec![t("c", "gamma")], &["c"]),
        ];
        let corpus = write_corpus(&scenarios);
        let out = tempfile::NamedTempFile::new().unwrap();
        let cfg = RunConfig {
            corpus_path: corpus.path().to_path_buf(),
            output_path: out.path().to_path_buf(),
            scenario_limit: Some(2),
            top_ks: vec![3],
            pool_sizes: vec![5],
            seed: 42,
        };
        let summary = run_retrieval(&cfg).unwrap();
        assert_eq!(summary.scenarios, 2);
        assert_eq!(summary.rows_written, 2);
    }

    #[test]
    fn run_creates_missing_output_directory() {
        let scenarios = vec![scenario("s1", "p1", vec![t("a", "alpha")], &["a"])];
        let corpus = write_corpus(&scenarios);
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("nested/sub/output.jsonl");
        let cfg = RunConfig {
            corpus_path: corpus.path().to_path_buf(),
            output_path: out.clone(),
            scenario_limit: None,
            top_ks: vec![3],
            pool_sizes: vec![1],
            seed: 42,
        };
        run_retrieval(&cfg).unwrap();
        assert!(out.exists());
    }

    #[test]
    fn distractor_shuffle_is_deterministic_per_seed() {
        let mut a = scenario_rng("s1", 42);
        let mut b = scenario_rng("s1", 42);
        let mut data_a: Vec<u32> = (0..10).collect();
        let mut data_b: Vec<u32> = (0..10).collect();
        data_a.shuffle(&mut a);
        data_b.shuffle(&mut b);
        assert_eq!(data_a, data_b);
    }

    #[test]
    fn distractor_shuffle_varies_per_scenario_id() {
        let mut a = scenario_rng("s1", 42);
        let mut b = scenario_rng("s2", 42);
        let mut data_a: Vec<u32> = (0..50).collect();
        let mut data_b: Vec<u32> = (0..50).collect();
        data_a.shuffle(&mut a);
        data_b.shuffle(&mut b);
        assert_ne!(
            data_a, data_b,
            "different scenario ids should yield different shuffles"
        );
    }
}
