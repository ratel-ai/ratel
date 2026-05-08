<div align="center">
  <h1>Ratel</h1>
  <h4>Context engineering for AI agents — engineer the context your agent actually needs, on every turn.</h4>

  <p>
    <a href="./docs/">Docs</a> •
    <a href="./docs/roadmap.md">Roadmap</a> •
    <a href="https://discord.gg/hdKpx69NR">Discord</a>
  </p>

  <p>
    <a href="https://www.npmjs.com/package/@ratel-ai/sdk"><img src="https://img.shields.io/npm/v/@ratel-ai/sdk?label=npm&color=cb3837" alt="npm" /></a>
    <a href="https://crates.io/crates/ratel-ai-core"><img src="https://img.shields.io/crates/v/ratel-ai-core?label=crates.io&color=e57300" alt="crates.io" /></a>
    <a href="https://github.com/ratel-ai/ratel/stargazers"><img src="https://img.shields.io/github/stars/ratel-ai/ratel?style=social" alt="GitHub stars" /></a>
    <a href="https://discord.gg/hdKpx69NR"><img src="https://img.shields.io/discord/1478702964003705015?logo=discord&logoColor=white&color=7289da&label=discord" alt="Discord" /></a>
    <a href="./LICENSE.md"><img src="https://img.shields.io/badge/license-ELv2-blue" alt="license" /></a>
  </p>
</div>

> Most agent stacks shove the whole tool catalog (and growing piles of skills, memories, message history) into the context window every turn — burning tokens and drifting on the long tail. Ratel sits between the agent and everything it could possibly need, and resolves only what matters for *this* turn.

## What is Ratel

Ratel is an in-process **context engineering platform** for AI agents: a catalog, a retrieval engine, and an in-process runtime that decide what ends up in the model's context window on every turn — so the agent works with less noise and fewer tokens.

The wedge today is **tool selection**. Register your tool catalog (or ingest an upstream MCP server's tools) into a Ratel `ToolCatalog`, and the model sees the handful of tools that matter for the current request — not the full list. The same primitives extend to skills, memories, and message history as those land on the roadmap; tools are just the first content type. See [`docs/overview.md`](docs/overview.md) for the thesis and [`docs/roadmap.md`](docs/roadmap.md) for what's coming.

The base is a Rust library, `ratel-ai-core`. On top sit a TypeScript SDK, an MCP server library, and a CLI that drops Ratel between an MCP host (Claude Code, Cursor, ChatGPT) and your upstream MCP servers.

No vector DB. No embedding pipeline. No service to deploy.

## Why Ratel

- **What ends up in the context window is a retrieval problem.** Tools are the easiest case to start with — discrete, structured, mid-cardinality. Ratel runs BM25 over a schema-aware text projection of every tool: deterministic, no embeddings, no inference cost on the retrieval path. Locked in [ADR‑0004](docs/adr/0004-bm25-tool-indexing.md). The same primitive carries forward to skills, memories, and chat history as those land on the roadmap.
- **From a multi-tool catalog to ~2 tools per turn.** Replace-by-default tool injection ([ADR‑0003](docs/adr/0003-tool-selection-replace-vs-suggest.md)) means the agent's tool list at any turn is the top‑K hits, not your whole catalog. Less context. Less drift. Lower cost.
- **In-process. No infra.** Drop the SDK in. The Rust core ships pre-built native bindings for darwin / linux / win — no Rust toolchain required to install.
- **Works with any TS framework** `ToolCatalog` returns generic `ExecutableTool` objects (`{id, name, description, inputSchema, outputSchema, execute}`) you wrap into your framework's tool type in a few lines. The repo ships a worked example for the Vercel AI SDK (`examples/ai-sdk`, `examples/mcp-chat`); the same pattern adapts to OpenAI Agents, Mastra, custom loops, anything. Or skip the agent framework entirely and expose the catalog over MCP server

## Where Ratel is most valuable today

| your situation | Ratel's value today |
|---|---|
| Local model + large catalog | **Critical.** qwen3.5 at pool=100 goes from 8% → 77% — the baseline collapses, Ratel keeps it working. |
| Open-source cloud + large catalog | **Strong win.** glm-5.1 at pool=180: **+12 pp** accuracy, **-85%** input tokens. |
| Frontier model + large catalog | **Cost-driven win.** Sonnet 4.6 at pool=180: **-82%** input tokens, **-68%** $; -8 pp accuracy (closing). |
| Any model + tiny catalog (≤30) | Skip Ratel — pool fits in the prompt cleanly. |

Numbers from the MetaTool agent benchmark — full per-pool breakdown and methodology in [`benchmark/RESULTS.md`](benchmark/RESULTS.md).

## Choose your path

Ratel ships in four shapes today, all built on the same Rust core. Pick one — or mix them:


|               | **Rust library**                          | **TypeScript SDK**                    | **MCP server**                                                                               | **CLI**                                                       |
| ------------- | ----------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **For**       | Rust agents and downstream SDKs           | TS / Node agents                      | Anyone running an MCP host (Claude Code, Cursor, ChatGPT) with multiple upstream MCP servers | Anyone migrating an existing Claude Code MCP setup into Ratel |
| **Install**   | `cargo add ratel-ai-core`                 | `pnpm add @ratel-ai/sdk`              | `pnpm add @ratel-ai/mcp-server`                                                              | `pnpm add -g @ratel-ai/cli`                                   |
| **Hero call** | `ToolRegistry::search`                    | `searchToolsTool(catalog)`            | `createMcpServer(catalog, …)`                                                                | `ratel mcp import`                                            |
| **Reference** | [src/core/lib/](src/core/lib/README.md) | [src/sdk/ts/](src/sdk/ts/README.md) | [src/integrations/mcp-server/](src/integrations/mcp-server/README.md)                      | [src/integrations/cli/](src/integrations/cli/README.md)     |


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

End-to-end with the Vercel AI SDK: [examples/ai-sdk/](examples/ai-sdk/README.md). To ingest an upstream MCP server's tools straight into a catalog, see [registerMcpServer](src/sdk/ts/README.md#registermcpserver--index-an-mcp-servers-tools-into-the-catalog). Full SDK reference: [src/sdk/ts/README.md](src/sdk/ts/README.md).

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

The connected MCP client sees exactly two tools — `search_tools` and `invoke_tool` — instead of every upstream's full tool list. OAuth 2.1 / PKCE for HTTP and SSE upstreams is handled centrally. Full reference: [src/integrations/mcp-server/README.md](src/integrations/mcp-server/README.md).

**CLI** — migrate an existing Claude Code MCP setup into Ratel

```bash
pnpm add -g @ratel-ai/cli

ratel mcp import   # interactive: scans ~/.claude.json + per-project .mcp.json,
                   # cherry-pick which upstreams to move into Ratel,
                   # rewrites Claude Code to launch `ratel mcp serve`.

ratel backup undo  # roll back any time — every change writes a timestamped backup under ~/.ratel/backups/.
```

`ratel mcp add` mirrors `claude mcp add` flag-for-flag. Three-scope hierarchy (user / project / local), OAuth flow, and full verb reference: [src/integrations/cli/README.md](src/integrations/cli/README.md).

**Rust library** — direct, no JS in the loop

```bash
cargo add ratel-ai-core
```

In-process BM25 retrieval over a schema-aware text projection of each tool. See [src/core/lib/README.md](src/core/lib/README.md) and [docs.rs/ratel-ai-core](https://docs.rs/ratel-ai-core).

## How it works (today)

Tool selection is the v0.1.x shipping path. Ratel sits between your agent and its tool catalog. At each turn, instead of dumping every tool's full schema into the model's context, the agent either calls `search_tools(query)` or — in pre-filter mode — receives the top‑K hits resolved at message start. The catalog can hold local executables, upstream MCP servers' tools (via `registerMcpServer`), or both. The model sees a unified, ranked surface and never the full list.

The base of all this is `ratel-ai-core`: a Rust BM25 index over a deterministic, schema-aware text projection of each tool. No embeddings, no vector DB, no inference latency on the retrieval path. Same primitives — a catalog and a retrieval engine over an in-process runtime — extend to other content types as they land.

For the longer take — context engineering as a thesis, and where Ratel is headed beyond tool retrieval (skills, telemetry-driven suggestions, memories, the context graph) — see [docs/overview.md](docs/overview.md).

## Examples

- [examples/ai-sdk/](examples/ai-sdk/README.md) — Vercel AI SDK with pre-filter + dynamic gateway
- [examples/mcp-chat/](examples/mcp-chat/README.md) — Vercel AI SDK REPL ingesting an upstream MCP server via `registerMcpServer`
- [examples/mcp-server/](examples/mcp-server/README.md) — Claude Code session fronted by Ratel as the only MCP

## Where this is going

Tool selection is the wedge, not the destination. Same catalog, same retrieval engine, same in-process runtime — widening, milestone by milestone, into the rest of the agent's context surface:

- **v0.1.x** — telemetry + UI inspector on tool usage, JSON → TOON encoding, optional MCP `tools/list_changed`, first-class **skills** ranked alongside tools by the same algorithm, **LLM-driven suggestions** that improve catalogs from telemetry, **multi-agent decomposition** hints, semantic search + re-ranking layered over BM25, an opt-in self-hosted server for cross-instance trace consolidation.
- **v0.2.x — chat management** — store / compact / prune / navigate long histories.
- **v0.3.x — memories** — prior decisions, preferences, and artifacts ranked into the current turn.
- **v0.4.x — context graph** — a unified tools-skills-memories substrate as the end state.
- **v0.5.x — Python SDK** — second host language binding the Rust core.

Dated milestones live in [`docs/roadmap.md`](docs/roadmap.md); the thesis behind the arc is in [`docs/overview.md`](docs/overview.md).

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

The durable record lives in [docs/adr/](docs/adr/). The cross-cutting locks worth knowing up front:

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