# Ratel

**The context layer for AI agents — register tools once, resolve only what matters.**

> Most agent stacks re-send every tool definition on every turn. Your agent reads 50 schemas, picks one, repeats — burning tokens and drifting on the long tail. Ratel sits between the agent and the catalog: register once, the agent only sees the tools that matter for *this* turn.

## What is Ratel

Ratel is an in-process **tool retrieval engine** for AI agents. Register your tool catalog (or ingest an upstream MCP server's tools) into a Ratel catalog; on every turn, Ratel ranks the catalog so the model only sees the handful relevant to the request — not the full list.

The base is a Rust library, `ratel-ai-core`. On top sit a TypeScript SDK, an MCP server library, and a CLI that drops Ratel between an MCP host (Claude Code, Cursor, ChatGPT) and your upstream MCP servers.

No vector DB. No embedding pipeline. No service to deploy.

## Why Ratel

- **Tool selection is a context problem, not a routing problem.** Ratel runs BM25 over a schema-aware text projection of every tool — deterministic, no embeddings, no inference cost on the retrieval path. Locked in [ADR‑0004](docs/adr/0004-bm25-tool-indexing.md).
- **From a multi-tool catalog to ~2 tools per turn.** Replace-by-default tool injection ([ADR‑0003](docs/adr/0003-tool-selection-replace-vs-suggest.md)) means the agent's tool list at any turn is the top‑K hits, not your whole catalog. Less context. Less drift. Lower cost.
- **In-process. No infra.** Drop the SDK in. The Rust core ships pre-built native bindings for darwin / linux / win — no Rust toolchain required to install.
- **Works with any TS framework** `ToolCatalog` returns generic `ExecutableTool` objects (`{id, name, description, inputSchema, outputSchema, execute}`) you wrap into your framework's tool type in a few lines. The repo ships a worked example for the Vercel AI SDK (`examples/ai-sdk`, `examples/mcp-chat`); the same pattern adapts to OpenAI Agents, Mastra, custom loops, anything. Or skip the agent framework entirely and expose the catalog over MCP server

## Choose your path

Ratel ships in four shapes today, all built on the same Rust core. Pick one — or mix them:


|               | **Rust library**                          | **TypeScript SDK**                    | **MCP server**                                                                               | **CLI**                                                       |
| ------------- | ----------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **For**       | Rust agents and downstream SDKs           | TS / Node agents                      | Anyone running an MCP host (Claude Code, Cursor, ChatGPT) with multiple upstream MCP servers | Anyone migrating an existing Claude Code MCP setup into Ratel |
| **Install**   | `cargo add ratel-ai-core`                 | `pnpm add @ratel-ai/sdk`              | `pnpm add @ratel-ai/mcp-server`                                                              | `pnpm add -g @ratel-ai/cli`                                   |
| **Hero call** | `ToolRegistry::search`                    | `searchToolsTool(catalog)`            | `createMcpServer(catalog, …)`                                                                | `ratel mcp import`                                            |
| **Reference** | `[src/core/lib/](src/core/lib/README.md)` | `[src/sdk/ts/](src/sdk/ts/README.md)` | `[src/integrations/mcp-server/](src/integrations/mcp-server/README.md)`                      | `[src/integrations/cli/](src/integrations/cli/README.md)`     |


The SDK and MCP server are layered on the same core; the CLI is the MCP server with config UX on top. Python SDK and Rust HTTP server are on the [roadmap](docs/roadmap.md), not yet shipped.

## Quickstart

**TypeScript SDK** — embed Ratel in a TS / Node agent

```bash
pnpm add @ratel-ai/sdk
```

```ts
import { ToolCatalog, searchToolsTool, invokeToolTool } from "@ratel-ai/sdk";

const catalog = new ToolCatalog();
catalog.register({
  id: "read_file",
  name: "read_file",
  description: "Read a file from local disk.",
  inputSchema: { properties: { path: { type: "string" } } },
  outputSchema: { properties: { contents: { type: "string" } } },
  execute: async ({ path }) => ({ contents: await fs.readFile(path, "utf8") }),
});

// Hand these two tools to your agent loop.
// The full catalog stays out of the model's context — the agent reaches it via search_tools / invoke_tool.
const search = searchToolsTool(catalog);
const invoke = invokeToolTool(catalog);
```

End-to-end with the Vercel AI SDK: `[examples/ai-sdk/](examples/ai-sdk/README.md)`. To ingest an upstream MCP server's tools straight into a catalog, see `[registerMcpServer](src/sdk/ts/README.md#registermcpserver--index-an-mcp-servers-tools-into-the-catalog)`. Full SDK reference: `[src/sdk/ts/README.md](src/sdk/ts/README.md)`.

**MCP server** — expose a catalog over MCP for Claude / Cursor / ChatGPT

```bash
pnpm add @ratel-ai/mcp-server @ratel-ai/sdk @modelcontextprotocol/sdk
```

```ts
import { ToolCatalog } from "@ratel-ai/sdk";
import { createMcpServer } from "@ratel-ai/mcp-server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const catalog = new ToolCatalog();
// register tools — or use buildGatewayFromConfig to ingest upstream MCP servers from a config

const handle = await createMcpServer(catalog, {
  name: "my-ratel-gateway",
  version: "0.1.0",
  transport: new StdioServerTransport(),
});
```

The connected MCP client sees exactly two tools — `search_tools` and `invoke_tool` — instead of every upstream's full tool list. OAuth 2.1 / PKCE for HTTP and SSE upstreams is handled centrally. Full reference: `[src/integrations/mcp-server/README.md](src/integrations/mcp-server/README.md)`.

**CLI** — migrate an existing Claude Code MCP setup into Ratel

```bash
pnpm add -g @ratel-ai/cli

ratel mcp import   # interactive: scans ~/.claude.json + per-project .mcp.json,
                   # cherry-pick which upstreams to move into Ratel,
                   # rewrites Claude Code to launch `ratel mcp serve`.

ratel backup undo  # roll back any time — every change writes a timestamped backup under ~/.ratel/backups/.
```

`ratel mcp add` mirrors `claude mcp add` flag-for-flag. Three-scope hierarchy (user / project / local), OAuth flow, and full verb reference: `[src/integrations/cli/README.md](src/integrations/cli/README.md)`.

**Rust library** — direct, no JS in the loop

```bash
cargo add ratel-ai-core
```

In-process BM25 retrieval over a schema-aware text projection of each tool. See `[src/core/lib/README.md](src/core/lib/README.md)` and [docs.rs/ratel-ai-core](https://docs.rs/ratel-ai-core).

## How it works

Ratel sits between your agent and its tool catalog. At each turn, instead of dumping every tool's full schema into the model's context, the agent either calls `search_tools(query)` or — in pre-filter mode — receives the top‑K hits resolved at message start. The catalog can hold local executables, upstream MCP servers' tools (via `registerMcpServer`), or both. The model sees a unified, ranked surface and never the full list.

The base of all this is `ratel-ai-core`: a Rust BM25 index over a deterministic, schema-aware text projection of each tool. No embeddings, no vector DB, no inference latency on the retrieval path.

For the longer take — context engineering as a thesis, and where Ratel is headed beyond tool retrieval (skills, memories, the context graph) — see `[docs/overview.md](docs/overview.md)`.

## Examples

- `[examples/ai-sdk/](examples/ai-sdk/README.md)` — Vercel AI SDK with pre-filter + dynamic gateway
- `[examples/mcp-chat/](examples/mcp-chat/README.md)` — Vercel AI SDK REPL ingesting an upstream MCP server via `registerMcpServer`
- `[examples/mcp-server/](examples/mcp-server/README.md)` — Claude Code session fronted by Ratel as the only MCP

## Roadmap

The full picture lives in `[docs/roadmap.md](docs/roadmap.md)`. The thread:

- **Soon (v0.1.x)** — telemetry + UI inspector, JSON→TOON encoding, first-class skills support.
- **Mid (v0.2.x – v0.3.x)** — LLM-driven tool/skill improvements from telemetry, multi-agent decomposition suggestions, semantic search + re-ranking, server flavor for trace consolidation.
- **Later** — chat management (store / compact / prune / navigate), memories integration, a unified tools-skills-memories graph, a Python SDK.

## Repo layout

```
src/
├── core/lib/                  # ratel-ai-core — Rust crate; BM25 retrieval engine
├── sdk/ts/                    # @ratel-ai/sdk — TypeScript SDK (NAPI-bound)
└── integrations/
    ├── mcp-server/            # @ratel-ai/mcp-server — expose a catalog as an MCP server
    └── cli/                   # @ratel-ai/cli — `ratel` CLI
benchmark/                     # Two-layer harness: Rust retrieval + TS agent campaign
examples/                      # Runnable end-to-end examples
docs/                          # Overview, roadmap, ADRs
```

## Build & test

Prerequisites: Rust stable (pinned via `rust-toolchain.toml`), Node 24+, pnpm 10.28+.

```bash
# Rust
cargo build --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --check --all
cargo test --workspace

# TS
pnpm install
pnpm -r build
pnpm -r typecheck
pnpm -r lint
pnpm -r test
```

CI runs both pipelines on every PR (`.github/workflows/{rust,ts}.yml`).

## Architecture decisions

The durable record lives in `[docs/adr/](docs/adr/)`. The cross-cutting locks worth knowing up front:

- [ADR 0002 — TS↔Rust binding via NAPI-RS](docs/adr/0002-ts-rust-binding-strategy.md)
- [ADR 0003 — Tool selection: replace by default, suggest opt-in](docs/adr/0003-tool-selection-replace-vs-suggest.md)
- [ADR 0004 — BM25 tool indexing strategy](docs/adr/0004-bm25-tool-indexing.md)
- [ADR 0006 — Benchmark corpus and eval modes](docs/adr/0006-benchmark-corpus-and-eval-modes.md)

## Contributing

Humans: see [CONTRIBUTING.md](CONTRIBUTING.md).
Coding agents working in this repo: see [AGENTS.md](AGENTS.md).
LLM index of the docs: [llms.txt](llms.txt).

## License

Source-available under the **Elastic License 2.0**, with an additional grant making it free to use in OSI-approved open-source projects. Non-open-source / commercial production use requires a commercial license. See [LICENSE.md](LICENSE.md).