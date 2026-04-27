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
}
