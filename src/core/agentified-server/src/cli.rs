use std::path::PathBuf;

use clap::{Parser, Subcommand};

#[derive(Debug, Parser)]
#[command(name = "agentified")]
#[command(about = "Agentified context intelligence server", long_about = None)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Command>,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Run the HTTP server with the MCP-over-HTTP endpoint mounted at /mcp.
    Serve {
        /// Dataset ID to expose via the MCP server.
        #[arg(long, env = "AGENTIFIED_DATASET", default_value = "default")]
        dataset: String,
    },
    /// Run the MCP server over stdio (for Claude Code and other local MCP clients).
    Mcp {
        /// Dataset ID to expose via the MCP server.
        #[arg(long, env = "AGENTIFIED_DATASET", default_value = "default")]
        dataset: String,
    },
    /// Analyze a project and emit a skills manifest + MCP client config.
    ///
    /// Output is hardcoded to the FinanceBot shape for the showcase iteration; the CLI surface
    /// is real, the analysis is canned. Writes `agentified.skills.json` and `.mcp.json` into
    /// the target path.
    Analyze {
        /// Project directory to scan and write output into. Defaults to the current directory.
        #[arg(default_value = ".")]
        path: PathBuf,
        /// Dataset ID to use in the emitted MCP config.
        #[arg(long, default_value = "financebot")]
        dataset: String,
    },
    /// Open the inspector UI to visualize recorded agent runs.
    ///
    /// Serves a self-contained HTML viewer that loads recordings from a directory and renders
    /// the skill/tool/cost/reliability story side-by-side.
    Inspect {
        /// Directory containing recording JSON files. Defaults to `./recordings`.
        #[arg(long, default_value = "./recordings")]
        recordings: PathBuf,
        /// Port to serve the inspector UI on.
        #[arg(long, env = "AGENTIFIED_INSPECT_PORT", default_value = "9120")]
        port: u16,
    },
}
