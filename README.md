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

> Most agents stuff every tool, skill, and memory into the context window each turn — burning tokens, drifting on the long tail. Ratel sits between the agent and its catalog, and resolves only what matters for *this* turn.

## What is Ratel

In-process **context engineering platform** for AI agents — a catalog, a retrieval engine, and an in-process runtime that decide what ends up in the model's context window on every turn.

- **Wedge today**: tool selection. Register tools (or ingest an upstream MCP server) into a `ToolCatalog`; the model sees the handful that matter for the current turn, not the full list.
- **Same primitives** extend to skills, memories, and message history as they land on the roadmap.
- **Stack**: Rust core (`ratel-ai-core`) + TypeScript SDK + CLI that drops Ratel between an MCP host (Claude Code, Cursor, ChatGPT) and upstream MCP servers.
- **No vector DB. No embedding pipeline. No service to deploy.**

See [`docs/overview.md`](docs/overview.md) for the thesis, [`docs/roadmap.md`](docs/roadmap.md) for what's coming.

## Why Ratel

- **Retrieval, not stuffing.** BM25 over a schema-aware text projection of every tool — deterministic, no embeddings, no inference cost on the retrieval path ([ADR‑0004](docs/adr/0004-bm25-tool-indexing.md)).
- **~2 tools per turn.** Replace-by-default tool injection ([ADR‑0003](docs/adr/0003-tool-selection-replace-vs-suggest.md)): the agent's tool list at any turn is the top‑K hits. Less context, less drift, lower cost.
- **In-process, no infra.** Pre-built native bindings for darwin / linux / win — no Rust toolchain to install.
- **Framework-agnostic.** `ToolCatalog` returns generic `ExecutableTool` objects you wrap in a few lines (Vercel AI SDK example shipped in `examples/ai-sdk`, `examples/mcp-chat`). Or skip the framework and expose the catalog over MCP.

## Where Ratel is most valuable today

| your situation | Ratel's value today |
|---|---|
| Local model + large catalog | **Critical.** qwen3.5 at pool=100 goes from 8% → 77% — the baseline collapses, Ratel keeps it working. |
| Open-source cloud + large catalog | **Strong win.** glm-5.1 at pool=180: **+12 pp** accuracy, **-85%** input tokens. |
| Frontier (Sonnet) + large catalog | **Cost-driven win.** Sonnet 4.6 at pool=180: **-82%** input tokens, **-68%** $; -8 pp accuracy (closing). |
| Frontier (Opus) + large catalog | **Competitive win.** Opus 4.6 pool=180: **+8 pp** accuracy and **-72%** tokens (discovery-tool arm). Opus 4.7 pool=180: ≈parity (-1.7 pp) with **-81%** tokens — Anthropic's own tool-search-tool loses **-8 pp** on the same setup. |
| Any model + tiny catalog (≤30) | Skip Ratel — pool fits in the prompt cleanly. |

Numbers from the MetaTool agent benchmark — full per-pool breakdown and methodology in [ratel-ai/ratel-bench › `RESULTS.md`](https://github.com/ratel-ai/ratel-bench/blob/main/RESULTS.md). The benchmark harness lives in its own public repo: [ratel-ai/ratel-bench](https://github.com/ratel-ai/ratel-bench).

## Choose your path

Three shapes, same Rust core. Pick one — or mix them:

|               | **Rust library**                          | **TypeScript SDK**                    | **CLI**                                                       |
| ------------- | ----------------------------------------- | ------------------------------------- | ------------------------------------------------------------- |
| **For**       | Rust agents and downstream SDKs           | TS / Node agents                      | Migrating an existing Claude Code MCP setup into Ratel        |
| **Install**   | `cargo add ratel-ai-core`                 | `pnpm add @ratel-ai/sdk`              | `pnpm add -g @ratel-ai/cli`                                   |
| **Hero call** | `ToolRegistry::search`                    | `searchToolsTool(catalog)`            | `ratel mcp import`                                            |
| **Reference** | [src/core/lib/](src/core/lib/README.md)   | [src/sdk/ts/](src/sdk/ts/README.md)   | [src/integrations/cli/](src/integrations/cli/README.md)       |

The MCP-server library that powers the CLI's gateway lives in a sibling repo: [ratel-ai/ratel-mcp](https://github.com/ratel-ai/ratel-mcp). Python SDK and Rust HTTP server are on the [roadmap](docs/roadmap.md), not yet shipped.

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

- End-to-end Vercel AI SDK: [examples/ai-sdk/](examples/ai-sdk/README.md)
- Ingest an upstream MCP server: [registerMcpServer](src/sdk/ts/README.md#registermcpserver--index-an-mcp-servers-tools-into-the-catalog)
- Full SDK reference: [src/sdk/ts/README.md](src/sdk/ts/README.md)

**MCP server** — expose a catalog over MCP for Claude / Cursor / ChatGPT

The MCP-server library and its `serve` CLI live in a sibling repo: [ratel-ai/ratel-mcp](https://github.com/ratel-ai/ratel-mcp). The published `@ratel-ai/mcp-server` package on npm is unchanged; `@ratel-ai/cli` in this repo depends on it and exposes the same gateway via `ratel serve`.

**CLI** — migrate an existing Claude Code MCP setup into Ratel

```bash
pnpm add -g @ratel-ai/cli

ratel mcp import   # interactive: scans ~/.claude.json + per-project .mcp.json,
                   # cherry-pick which upstreams to move into Ratel,
                   # rewrites Claude Code to launch `ratel serve`.

ratel backup undo  # roll back any time — every change writes a timestamped backup under ~/.ratel/backups/.
```

`ratel mcp add` mirrors `claude mcp add` flag-for-flag. Three-scope hierarchy (user / project / local), OAuth flow, full verb reference: [src/integrations/cli/README.md](src/integrations/cli/README.md).

**Rust library** — direct, no JS in the loop

```bash
cargo add ratel-ai-core
```

In-process BM25 retrieval over a schema-aware text projection of each tool. See [src/core/lib/README.md](src/core/lib/README.md) and [docs.rs/ratel-ai-core](https://docs.rs/ratel-ai-core).

## How it works (today)

- **Tool selection** is the v0.1.x shipping path. Ratel sits between agent and catalog.
- Each turn, the agent either calls `search_tools(query)` or — in pre-filter mode — receives the top‑K hits resolved at message start. The full list never enters context.
- The catalog holds local executables, upstream MCP servers' tools (via `registerMcpServer`), or both — the model sees a unified, ranked surface.
- Under the hood: `ratel-ai-core`, a Rust BM25 index over a deterministic, schema-aware text projection of each tool. No embeddings, no vector DB, no inference latency on the retrieval path.

Longer take + skills / telemetry / memories / context graph: [docs/overview.md](docs/overview.md).

## Examples

- [examples/ai-sdk/](examples/ai-sdk/README.md) — Vercel AI SDK with pre-filter + dynamic gateway
- [examples/mcp-chat/](examples/mcp-chat/README.md) — Vercel AI SDK REPL ingesting an upstream MCP server via `registerMcpServer`

## Where this is going

Tool selection is the wedge, not the destination. Same catalog, same retrieval engine, same in-process runtime — widening into the rest of the agent's context surface:

- **v0.1.x** — telemetry + UI inspector, JSON→TOON encoding, MCP `tools/list_changed`, first-class **skills**, LLM-driven catalog suggestions, multi-agent decomposition hints, semantic re-ranking over BM25, opt-in self-hosted trace server.
- **v0.2.x — chat management** — store / compact / prune / navigate long histories.
- **v0.3.x — memories** — prior decisions, preferences, and artifacts ranked into the current turn.
- **v0.4.x — context graph** — unified tools-skills-memories substrate.
- **v0.5.x — Python SDK** — second host language on the Rust core.

Dated milestones: [`docs/roadmap.md`](docs/roadmap.md). Thesis: [`docs/overview.md`](docs/overview.md).

## Repo layout

```
src/
├── core/lib/                  # ratel-ai-core — Rust crate; BM25 retrieval engine
├── sdk/ts/                    # @ratel-ai/sdk — TypeScript SDK (NAPI-bound)
└── integrations/
    └── cli/                   # @ratel-ai/cli — `ratel` CLI
examples/                      # Runnable end-to-end examples
docs/                          # Overview, roadmap, ADRs
```

The benchmark harness lives in its own public repo: [ratel-ai/ratel-bench](https://github.com/ratel-ai/ratel-bench).

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

Full record in [docs/adr/](docs/adr/). Cross-cutting locks worth knowing up front:

- [ADR 0002 — TS↔Rust binding via NAPI-RS](docs/adr/0002-ts-rust-binding-strategy.md)
- [ADR 0003 — Tool selection: replace by default, suggest opt-in](docs/adr/0003-tool-selection-replace-vs-suggest.md)
- [ADR 0004 — BM25 tool indexing strategy](docs/adr/0004-bm25-tool-indexing.md)
- [ADR 0006 — Benchmark corpus and eval modes](docs/adr/0006-benchmark-corpus-and-eval-modes.md)

## Contributing

- Humans: [CONTRIBUTING.md](CONTRIBUTING.md)
- Coding agents in this repo: [AGENTS.md](AGENTS.md)
- LLM index of the docs: [llms.txt](llms.txt)

## License

**Elastic License 2.0**, with a grant making it free for OSI-approved open-source projects. Non-OSS / commercial production use requires a commercial license. See [LICENSE.md](LICENSE.md).