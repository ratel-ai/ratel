use std::path::{Path, PathBuf};
use std::process::Command as ShellCommand;

use anyhow::Context;
use clap::{Parser, Subcommand};
use ratel_benchmark::ingest::metatool::{
    self as metatool, MetaToolPaths, PLUGIN_DES_URL, SINGLE_TOOL_CSV_URL, SampleSpec,
    ingest_to_jsonl as ingest_metatool,
};
use ratel_benchmark::runner::{RunConfig, run_retrieval};

#[derive(Parser)]
#[command(name = "ratel-benchmark", version, about = "Ratel benchmark harness")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Compute BM25 retrieval-only metrics for every scenario in a corpus.
    Retrieval {
        /// Path to the JSONL scenario corpus.
        #[arg(short, long)]
        corpus: PathBuf,
        /// Where to write retrieval.jsonl.
        #[arg(short, long, default_value = "benchmark/results/retrieval.jsonl")]
        output: PathBuf,
        /// Limit to first N scenarios (full corpus if omitted).
        #[arg(long)]
        scenarios: Option<usize>,
        /// Top-K cutoffs for recall/precision/MRR, comma-separated. One row
        /// per (scenario, pool_size, k) is emitted from a single ranking pass.
        #[arg(long, value_delimiter = ',', default_values_t = [1usize, 3, 5, 10])]
        top_k: Vec<usize>,
        /// Catalog sizes to evaluate at, comma-separated.
        #[arg(long, value_delimiter = ',', default_values_t = [30usize, 150, 600])]
        pool_sizes: Vec<usize>,
        /// Seed for distractor shuffling.
        #[arg(long, default_value_t = 42)]
        seed: u64,
    },
    /// Convert an external corpus into the harness's normalized JSONL format.
    Ingest {
        #[command(subcommand)]
        source: IngestSource,
    },
}

#[derive(Subcommand)]
enum IngestSource {
    /// MetaTool (HowieHwong/MetaTool, MIT). With `--download` the upstream
    /// sources are pulled (via curl) into `--fixtures-dir` before ingesting,
    /// so a clean clone can produce the snapshot in one command.
    Metatool {
        /// Where downloaded source files live, mirroring upstream `dataset/`.
        #[arg(long, default_value = "benchmark/fixtures/metatool")]
        fixtures_dir: PathBuf,
        /// Pull upstream sources into `--fixtures-dir` before ingesting (uses
        /// the system `curl`). Skip the flag to read pre-existing files.
        #[arg(long, default_value_t = false)]
        download: bool,
        /// Override path to `plugin_des.json`. Defaults under `--fixtures-dir`.
        #[arg(long)]
        plugins: Option<PathBuf>,
        /// Override path to `all_clean_data.csv`. Defaults under `--fixtures-dir`.
        #[arg(long)]
        single_tool: Option<PathBuf>,
        /// Override path to `multi_tool_query_golden.json`. Defaults under
        /// `--fixtures-dir`. Pass an empty string to skip multi-tool ingest.
        #[arg(long)]
        multi_tool: Option<PathBuf>,
        /// Where to write the normalized JSONL corpus.
        #[arg(short, long, default_value = "benchmark/test-data/metatool.jsonl")]
        output: PathBuf,
        /// Total number of scenarios to keep (single + multi combined).
        #[arg(long, default_value_t = 1000)]
        sample: usize,
        /// Fraction of `sample` reserved for multi-tool scenarios. Best-effort.
        #[arg(long, default_value_t = 0.03)]
        multi_tool_ratio: f64,
        /// Seed for deterministic sampling.
        #[arg(long, default_value_t = 42)]
        seed: u64,
    },
}

fn fetch_via_curl(url: &str, dest: &Path) -> anyhow::Result<()> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    let status = ShellCommand::new("curl")
        .args(["-sSL", "--fail", "-o"])
        .arg(dest)
        .arg(url)
        .status()
        .with_context(|| format!("invoking curl for {url}"))?;
    if !status.success() {
        anyhow::bail!(
            "curl exited with status {} fetching {url}",
            status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "?".into())
        );
    }
    Ok(())
}

fn download_metatool_upstream(paths: &MetaToolPaths) -> anyhow::Result<()> {
    eprintln!("downloading MetaTool upstream sources via curl...");
    fetch_via_curl(PLUGIN_DES_URL, &paths.plugins)?;
    fetch_via_curl(SINGLE_TOOL_CSV_URL, &paths.single_tool)?;
    if let Some(multi) = &paths.multi_tool {
        fetch_via_curl(metatool::MULTI_TOOL_JSON_URL, multi)?;
    }
    Ok(())
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Retrieval {
            corpus,
            output,
            scenarios,
            top_k,
            pool_sizes,
            seed,
        } => {
            let cfg = RunConfig {
                corpus_path: corpus,
                output_path: output.clone(),
                scenario_limit: scenarios,
                top_ks: top_k,
                pool_sizes,
                seed,
            };
            let summary = run_retrieval(&cfg)?;
            println!(
                "wrote {} rows for {} scenarios → {}",
                summary.rows_written,
                summary.scenarios,
                output.display()
            );
        }
        Command::Ingest { source } => match source {
            IngestSource::Metatool {
                fixtures_dir,
                download,
                plugins,
                single_tool,
                multi_tool,
                output,
                sample,
                multi_tool_ratio,
                seed,
            } => {
                let defaults = MetaToolPaths::under_fixtures_dir(&fixtures_dir);
                let paths = MetaToolPaths {
                    plugins: plugins.unwrap_or(defaults.plugins),
                    single_tool: single_tool.unwrap_or(defaults.single_tool),
                    // An empty `--multi-tool` flag (`--multi-tool ""`) opts out;
                    // omitting the flag falls through to the fixtures-dir default.
                    multi_tool: multi_tool
                        .map(|p| {
                            if p.as_os_str().is_empty() {
                                None
                            } else {
                                Some(p)
                            }
                        })
                        .unwrap_or(defaults.multi_tool),
                };
                if download {
                    download_metatool_upstream(&paths)?;
                }
                let stats = ingest_metatool(
                    &paths,
                    &SampleSpec {
                        total: sample,
                        multi_tool_ratio,
                        seed,
                    },
                    &output,
                )?;
                println!(
                    "metatool: {} plugins, {} single-tool in / {} multi-tool in, \
                     {} skipped (unknown gold) → {} scenarios at {}",
                    stats.plugins_loaded,
                    stats.single_tool_in,
                    stats.multi_tool_in,
                    stats.skipped_unknown_gold,
                    stats.scenarios_out,
                    output.display(),
                );
            }
        },
    }
    Ok(())
}
