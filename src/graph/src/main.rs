//! `ratel-graph` — rebuild a usage-ranking intent graph from local trace logs
//! and look at it.
//!
//! ```text
//! ratel-graph show  [dir]   summarize the graph a replay produces
//! ratel-graph build [dir]   emit it as protocol/v1 JSON on stdout
//! ```
//!
//! `dir` defaults to `~/.ratel/telemetry`. `build` writes to stdout rather than
//! a fixed path so it composes with a redirect and makes no assumption about
//! where a graph is supposed to live — durable storage is a separate concern.

use std::path::PathBuf;
use std::process::ExitCode;

use ratel_ai_graph::{render, replay_dir};

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let command = args.next().unwrap_or_else(|| "show".into());
    let dir = args.next().map(PathBuf::from).unwrap_or_else(default_dir);

    match command.as_str() {
        "show" | "build" => {}
        "-h" | "--help" | "help" => {
            eprintln!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        other => {
            eprintln!("unknown command {other:?}\n\n{USAGE}");
            return ExitCode::FAILURE;
        }
    }

    let (graph, stats) = match replay_dir(&dir) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("could not read {}: {e}", dir.display());
            return ExitCode::FAILURE;
        }
    };

    match command.as_str() {
        "build" => match serde_json::to_string_pretty(&graph) {
            Ok(json) => println!("{json}"),
            Err(e) => {
                eprintln!("could not serialize the graph: {e}");
                return ExitCode::FAILURE;
            }
        },
        _ => {
            // Counts first: they distinguish "no telemetry" from "telemetry, but
            // nothing was ever invoked after a search" — very different problems
            // that both end in an empty graph.
            eprintln!(
                "{} file(s), {} event(s), {} session(s){}\n",
                stats.files,
                stats.envelopes,
                stats.sessions,
                if stats.skipped_lines > 0 {
                    format!(", {} unparseable line(s) skipped", stats.skipped_lines)
                } else {
                    String::new()
                }
            );
            print!("{}", render(&graph));
        }
    }
    ExitCode::SUCCESS
}

fn default_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default()
        .join(".ratel/telemetry")
}

const USAGE: &str = "\
ratel-graph — rebuild and inspect a Ratel usage-ranking intent graph

USAGE:
    ratel-graph show  [dir]    summarize the graph a replay of `dir` produces
    ratel-graph build [dir]    emit that graph as protocol/v1 JSON on stdout

`dir` defaults to ~/.ratel/telemetry and is searched recursively for *.jsonl.
Nothing is written: `build` prints to stdout, so redirect it where you want it.";
