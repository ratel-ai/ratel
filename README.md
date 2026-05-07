# Ratel

The **context engineering platform** for AI agents — the layer that decides what ends up in an agent's context window, so the agent works with less noise, fewer tokens, and fewer round-trips between model and tool calls.

The base of the platform is an algorithm and a library. On top of that base sit a growing set of products and integrations — the flagship today being a Ratel **MCP server** plus a **CLI** that puts Ratel between Claude Code (or any MCP client) and the rest of your MCP servers.

Latest measured impact: 70–85% input-token reduction at realistic pool sizes; large open-source models gain ~10 pp accuracy at scale, and local `qwen3.5` jumps from 8% → 77% pass rate at pool=100 on a MacBook M4. Full breakdown in [`benchmark/RESULTS.md`](benchmark/RESULTS.md).

## What you can use today

### Core: `ratel-ai-core` (Rust library)

In-process tool retrieval. Register your tool catalog, query it, get a ranked top-K. BM25 today (semantic + re-ranking on the roadmap), no infra to stand up. See [`src/core/lib/README.md`](src/core/lib/README.md). Locked decisions: [ADR-0003](docs/adr/0003-tool-selection-replace-vs-suggest.md) (replace-by-default tool injection), [ADR-0004](docs/adr/0004-bm25-tool-indexing.md) (BM25 indexing strategy).

### SDK: `@ratel-ai/sdk` (TypeScript)

Bundles `ratel-ai-core` via NAPI-RS ([ADR-0002](docs/adr/0002-ts-rust-binding-strategy.md)) so any JS/TS agent can drop it in. Exposes a framework-neutral `ToolCatalog`, gateway factories (`searchToolsTool`, `invokeToolTool`) usable from any agent loop, and `registerMcpServer(catalog, { name, transport })` to ingest an upstream MCP server's tools straight into a Ratel catalog. See [`src/sdk/ts/README.md`](src/sdk/ts/README.md).

```bash
pnpm add @ratel-ai/sdk
```

### Integration: `@ratel-ai/cli` + `@ratel-ai/mcp-server` (the Claude Code path)

The `ratel` CLI and the MCP-server library together let you put Ratel **between** an MCP client (Claude Code, Claude Desktop, an agent framework) and the upstream MCP servers it would otherwise talk to directly. The client sees three tools — `search_tools`, `invoke_tool`, `auth` — instead of every upstream's full tool list, dispatched through Ratel's ranking. OAuth 2.1 / PKCE is handled centrally for HTTP and SSE upstreams, with tokens persisted at `~/.ratel/oauth/<name>.json`.

Headline verbs:

| Command | What it does |
|---|---|
| `ratel mcp import` | One-shot migration: scans Claude Code's existing MCP setup across all three scopes, lets you pick which upstreams to move into Ratel, then rewrites Claude to point at `ratel mcp serve`. |
| `ratel mcp add` | Add an MCP server to Ratel. Same positional/flag layout as `claude mcp add`. For HTTP/SSE, drives the OAuth flow inline. |
| `ratel mcp serve` | Start the gateway over stdio. This is the bin Claude Code launches after `import`. |
| `ratel mcp auth [<name>]` | (Re-)run the OAuth flow for an HTTP/SSE upstream. |
| `ratel mcp list` | List configured upstreams across user / project / local scopes, with auth status. |

See [`src/integrations/cli/README.md`](src/integrations/cli/README.md) and [`src/integrations/mcp-server/README.md`](src/integrations/mcp-server/README.md) for the full surface.

## Quickstart for Claude Code users

```bash
# 1. Install the CLI globally.
pnpm add -g @ratel-ai/cli

# 2. Migrate your existing Claude Code MCP setup into Ratel.
#    The wizard scans ~/.claude.json and per-project .mcp.json,
#    lets you cherry-pick which upstreams to move, and rewrites
#    Claude to launch `ratel mcp serve` instead of each upstream
#    directly. A timestamped backup is written under ~/.ratel/backups/.
ratel mcp import

# 3. Restart Claude Code. Your upstream tools are now reachable
#    via the `search_tools` + `invoke_tool` pair, and OAuth-protected
#    HTTP/SSE upstreams expose an `auth` tool to (re)authorize.

# Roll back any time:
ratel backup undo
```

If you'd rather configure manually, skip `import` and add servers one at a time — same flag layout as Claude's:

```bash
ratel mcp add --scope user stripe https://mcp.stripe.com --transport http
ratel mcp add --scope project airtable -e API_KEY=xyz -- npx -y airtable-mcp-server
```

For the LLM reading this and trying to wire Ratel up: the entry point is `ratel mcp import`. It is interactive but every prompt has a sensible default. After it runs, the user just restarts Claude Code. There is no separate config file you need to hand-author.

## What's coming

The v1 wedge is tool selection. Under the same context-engineering thesis, future milestones layer onto the same primitives:

- **Soon (v0.1.x)**: telemetry + UI inspector for tool usage and traces; JSON→TOON encoding to cut per-call token spend; first-class skills support (registered alongside tools, ranked by the same algorithm).
- **Mid (v0.2.x – v0.3.x roughly)**: LLM-based suggestions for tool/skill improvements driven by telemetry; multi-agent decomposition suggestions; semantic search (local + optional cloud embeddings) and re-ranking (LLM + XGBoost); a server flavor that consolidates traces across multiple agent instances.
- **Later**: chat management — store / compact / prune / navigate messages so long-running agents don't blow their context budget. Memories integration so prior context informs tool selection. Eventually a unified tools-skills-memories graph and a Python SDK.

The roadmap lives in [`plan.md`](plan.md) (gitignored, working file). Status of what's actually shipped vs. in-flight lives in [`progress.md`](progress.md).

## Repo layout

```
src/
├── core/lib/                  # ratel-ai-core — Rust crate; the algorithm at the base
├── sdk/ts/                    # @ratel-ai/sdk — TypeScript SDK that bundles ratel-ai-core
└── integrations/
    ├── mcp-server/            # @ratel-ai/mcp-server — library: expose a catalog as an MCP server
    └── cli/                   # @ratel-ai/cli — `ratel` CLI: scope mgmt, gateway, Claude-Code import, OAuth
benchmark/                     # Two-layer harness: Rust retrieval + TS agent campaign — see RESULTS.md
examples/                      # ai-sdk, mcp-chat, mcp-server end-to-end examples
docs/adr/                      # Architecture decision records
```

`src/core/server/` (central server) and `src/sdk/py/` (Python SDK) aren't scaffolded until they're being implemented.

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

See [`docs/adr/`](docs/adr/) for the durable record. The cross-cutting locks worth knowing up front:

- [ADR 0002 — TS↔Rust binding via NAPI-RS](docs/adr/0002-ts-rust-binding-strategy.md)
- [ADR 0003 — Tool selection: replace by default, suggest opt-in](docs/adr/0003-tool-selection-replace-vs-suggest.md)
- [ADR 0004 — BM25 tool indexing strategy](docs/adr/0004-bm25-tool-indexing.md)
- [ADR 0006 — Benchmark corpus and eval modes](docs/adr/0006-benchmark-corpus-and-eval-modes.md)
- [ADR 0007 — Benchmark corpus not snapshotted](docs/adr/0007-benchmark-corpus-not-snapshotted.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Source-available under the **Elastic License 2.0**, with an additional grant making it free to use in OSI-approved open-source projects. Non-open-source / commercial production use requires a commercial license. See [LICENSE.md](LICENSE.md).
