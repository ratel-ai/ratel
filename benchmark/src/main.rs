use std::path::PathBuf;

use clap::{Parser, Subcommand};
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
        /// Top-K cutoff for recall/precision/MRR.
        #[arg(long, default_value_t = 5)]
        top_k: usize,
        /// Catalog sizes to evaluate at, comma-separated.
        #[arg(long, value_delimiter = ',', default_values_t = [30usize, 150, 600])]
        pool_sizes: Vec<usize>,
        /// Seed for distractor shuffling.
        #[arg(long, default_value_t = 42)]
        seed: u64,
    },
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
                top_k,
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
    }
    Ok(())
}
