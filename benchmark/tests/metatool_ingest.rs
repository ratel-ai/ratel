//! End-to-end checks for the MetaTool ingestion pipeline.
//!
//! Runs `ingest_to_jsonl` against the committed mini fixture and asserts that
//! the produced JSONL parses cleanly through the corpus loader and round-trips
//! through the retrieval runner with finite metrics.

use std::path::PathBuf;

use ratel_benchmark::corpus::parse_scenarios;
use ratel_benchmark::ingest::metatool::{MetaToolPaths, SampleSpec, ingest_to_jsonl};
use ratel_benchmark::runner::{RunConfig, run_retrieval};

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("test-data")
        .join("metatool-mini")
}

fn fixture_paths() -> MetaToolPaths {
    let dir = fixture_dir();
    MetaToolPaths {
        plugins: dir.join("plugin_des.json"),
        single_tool: dir.join("all_clean_data.csv"),
        multi_tool: Some(dir.join("multi_tool_query_golden.json")),
    }
}

#[test]
fn ingest_writes_jsonl_parsable_by_corpus_loader() {
    let out = tempfile::NamedTempFile::new().unwrap();
    let stats = ingest_to_jsonl(
        &fixture_paths(),
        &SampleSpec {
            total: 100,
            multi_tool_ratio: 0.25,
            seed: 42,
        },
        out.path(),
    )
    .unwrap();

    // The mini fixture has 6 single-tool rows + 2 multi-tool rows; both
    // universes are valid against the mini plugin_des.
    assert_eq!(stats.plugins_loaded, 6);
    assert_eq!(stats.single_tool_in, 6);
    assert_eq!(stats.multi_tool_in, 2);
    assert_eq!(stats.skipped_unknown_gold, 0);
    assert_eq!(stats.scenarios_out, 8);

    let scenarios = parse_scenarios(std::io::BufReader::new(
        std::fs::File::open(out.path()).unwrap(),
    ))
    .unwrap();
    assert_eq!(scenarios.len(), 8);
    for s in &scenarios {
        assert!(!s.gold_tools.is_empty());
        for tool in &s.candidate_pool {
            // MetaTool plugins ship without parameter schemas.
            assert!(tool.input_schema.as_object().is_some_and(|o| o.is_empty()));
            assert!(tool.output_schema.as_object().is_some_and(|o| o.is_empty()));
        }
        assert!(s.judge_criteria.is_none());
        assert!(s.id.starts_with("metatool-"));
    }
}

#[test]
fn ingest_round_trips_through_retrieval_runner() {
    let corpus = tempfile::NamedTempFile::new().unwrap();
    ingest_to_jsonl(
        &fixture_paths(),
        &SampleSpec {
            total: 100,
            multi_tool_ratio: 0.25,
            seed: 42,
        },
        corpus.path(),
    )
    .unwrap();

    let retrieval_out = tempfile::NamedTempFile::new().unwrap();
    let summary = run_retrieval(&RunConfig {
        corpus_path: corpus.path().to_path_buf(),
        output_path: retrieval_out.path().to_path_buf(),
        scenario_limit: None,
        top_ks: vec![1, 3],
        pool_sizes: vec![3, 6],
        seed: 42,
    })
    .unwrap();
    assert_eq!(summary.scenarios, 8);
    // 8 scenarios × 2 pool sizes × 2 K cutoffs = 32 rows.
    assert_eq!(summary.rows_written, 32);

    let body = std::fs::read_to_string(retrieval_out.path()).unwrap();
    let mut row_count = 0usize;
    for line in body.lines().filter(|l| !l.is_empty()) {
        let row: serde_json::Value = serde_json::from_str(line).unwrap();
        for key in ["recall_at_k", "reciprocal_rank", "precision_at_k"] {
            let v = row[key].as_f64().expect(key);
            assert!(v.is_finite(), "{key} should be finite, got {v}");
            assert!(
                (0.0..=1.0).contains(&v),
                "{key} should be within [0,1], got {v}"
            );
        }
        assert!(row["hit_at_k"].is_boolean());
        row_count += 1;
    }
    assert_eq!(row_count, 32);
}

#[test]
fn ingest_skips_query_with_unknown_gold() {
    // Override the single-tool CSV with one row referencing a missing plugin.
    let dir = tempfile::tempdir().unwrap();
    let plugins = dir.path().join("plugin_des.json");
    std::fs::write(&plugins, r#"{"WeatherTool":"weather"}"#).unwrap();
    let single = dir.path().join("single.csv");
    std::fs::write(&single, "Query,Tool\nfine,WeatherTool\nbad,Bogus\n").unwrap();

    let out = dir.path().join("out.jsonl");
    let stats = ingest_to_jsonl(
        &MetaToolPaths {
            plugins,
            single_tool: single,
            multi_tool: None,
        },
        &SampleSpec {
            total: 10,
            multi_tool_ratio: 0.0,
            seed: 1,
        },
        &out,
    )
    .unwrap();
    assert_eq!(stats.scenarios_out, 1);
    assert_eq!(stats.skipped_unknown_gold, 1);
}
