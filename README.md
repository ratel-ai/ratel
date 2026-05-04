# Ratel

The **context engineering platform** for AI agents — the layer that decides what ends up in an agent's context window, so the agent works with less noise, fewer tokens, and fewer round-trips between model and tool calls.

## v1 wedge: tool selection

Today, agents load every registered tool into the context whether it's relevant or not. Ratel ranks tools per-query (BM25 first; semantic + re-ranking later) and returns only the top-K. Auth, telemetry, and tool-suggestion features layer on top of the same primitive in later milestones.

The product is a Rust library at its core (`ratel-core`) — in-process, no infra. A TypeScript SDK (`@ratel-ai/sdk`) bundles the lib so JS/TS agents can drop it in with one dependency. An MCP gateway and a central server come later, only when needed.

## First demo target (v0.1.x)

A Claude Code session consumes fewer input tokens once Ratel is added, with a benchmark in `benchmark/` backing the claim.

## Status

**v0.1.0 in development on the `revamp` branch.** This milestone is the chassis — workspaces, CI, ADRs, contributor docs. No product code yet. v0.1.1 (BM25 retrieval) lands next.

## Repo layout

```
src/
├── core/lib/                  # ratel-core — Rust crate; the product's heart
├── sdk/ts/                    # @ratel-ai/sdk — TypeScript SDK that bundles ratel-core
└── integrations/
    ├── mcp-server/            # @ratel-ai/mcp-server — library: expose a catalog as an MCP server
    └── cli/                   # @ratel-ai/cli — `ratel` CLI: scope management, gateway, Claude-Code import
benchmark/                     # Rust harness for retrieval-quality evaluation
docs/adr/                      # Architecture decision records
```

Future milestones add `src/core/server/` (central server), more entries under `src/integrations/`, and `src/sdk/py/` (Python SDK). Not scaffolded until they're being implemented.

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

See [`docs/adr/`](docs/adr/) for the durable record. The cross-cutting locks for v0.1.0:

- [ADR 0002 — TS↔Rust binding via NAPI-RS](docs/adr/0002-ts-rust-binding-strategy.md)
- [ADR 0003 — Tool selection: replace by default, suggest opt-in](docs/adr/0003-tool-selection-replace-vs-suggest.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Source-available under the **Elastic License 2.0**, with an additional grant making it free to use in OSI-approved open-source projects. Non-open-source / commercial production use requires a commercial license. See [LICENSE.md](LICENSE.md).
