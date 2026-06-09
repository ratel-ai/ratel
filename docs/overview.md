# Ratel — Overview

> **The context layer for AI agents — register tools once, resolve only what matters.**

This is the longer take on what Ratel is, why it exists, and where it's going. For install commands and quickstarts, start at the [README](../README.md). For the durable architectural decisions, see [`docs/adr/`](adr/). For the time-tagged feature roadmap, see [`docs/roadmap.md`](roadmap.md).

> **Three repos, one story.** This repo (`ratel-ai/ratel`) is the **library** — the engine you embed in your agent. [`ratel-ai/ratel-mcp`](https://github.com/ratel-ai/ratel-mcp) is the **first showcase** — `@ratel-ai/mcp-server`, a real product built on the library, exposing any catalog over MCP and fronting Claude Code / Cursor / ChatGPT against multiple upstream MCP servers. [`ratel-ai/ratel-bench`](https://github.com/ratel-ai/ratel-bench) is the **proof** — the benchmark harness whose numbers anchor every accuracy / cost claim we make. The rest of this document is about the library half.

---

## The problem

Every modern agent runtime has the same loop: gather tools, render their schemas into the model's context, let the model pick one, execute, repeat. The loop scales badly as the catalog grows:

- **Token cost compounds**. A 50-tool catalog at ~300 tokens of schema each is 15K tokens of input on *every* turn — paid by the user, every step.
- **Selection accuracy drops**. Models drift on long tool lists. The right tool is buried; the model picks a near-neighbour or invents arguments.
- **Round-trips multiply**. When the model can't find what it needs, it calls a wrong tool, gets an error, retries — burning latency and trust.

The reflexive answer is to add a vector database, embed every tool, and route by similarity. That works, sort of, but it adds a service to deploy, an embedding pipeline to maintain, an inference call on the retrieval path, and an assumption — *similarity equals relevance* — that is wrong often enough to matter.

We think tool selection is a **context engineering** problem, not a routing problem. The right primitive is "what should be in the model's context window on this turn," and the right answer is rarely "everything you registered at boot."

## The thesis

Ratel is an in-process retrieval engine for tools, with one job today: **decide which tools belong in the model's context for this turn.**

The shape is deliberate:

1. **A catalog is a first-class object.** You register tools once — local executables, MCP server tools, skills (coming) — into a `ToolCatalog`. The catalog is the substrate; everything else operates on it.
2. **The agent never sees the full catalog.** Replace-by-default tool injection ([ADR‑0003](adr/0003-tool-selection-replace-vs-suggest.md)) means the model's tool list at any turn is the top‑K hits for the current request, not the catalog itself.
3. **Retrieval is deterministic and cheap.** BM25 over a schema-aware text projection of each tool ([ADR‑0004](adr/0004-bm25-tool-indexing.md)). No embeddings, no vector DB, no inference call on the retrieval path. The cost is microseconds per query, in-process.
4. **The runtime is the user's process.** No service to deploy, no cluster to scale. The Rust core ships as a library; the TS SDK bundles a pre-built native binding so it installs with `pnpm add` and no Rust toolchain.

The trade we made: we don't try to "understand" tools the way an embedding model would. We index their text — names, descriptions, parameter names, enum values — and rank by lexical match. That sounds primitive, until you notice that tool descriptions written for LLMs are already engineered to be lexically informative. BM25 over that surface is competitive with, and often beats, embedding-based retrieval on tool selection. The benchmarks driving this claim live in [ratel-ai/ratel-bench](https://github.com/ratel-ai/ratel-bench) and [ADR‑0006](adr/0006-benchmark-corpus-and-eval-modes.md).

## What ships today

**Library (this repo).** Everything below is on `main` and published to crates.io / npm:

- **`ratel-ai-core`** — the Rust library. BM25 tool retrieval, deterministic schema-aware tokenization, in-process. The base everything else wraps.
- **`@ratel-ai/sdk`** — the TypeScript SDK. Bundles `ratel-ai-core` via NAPI-RS ([ADR‑0002](adr/0002-ts-rust-binding-strategy.md)). Exposes `ToolRegistry`, `ToolCatalog`, gateway tool factories (`searchCapabilitiesTool`, `invokeToolTool`), and `registerMcpServer` to ingest an upstream MCP server's tools straight into a catalog.
- **`@ratel-ai/cli`** — the `ratel` binary. Auxiliary tooling for the artifacts the library writes: `ratel inspect` summarizes telemetry sessions; the transitional `mcp` / `serve` / `backup` verbs are retained but the canonical home for those is the showcase repo's `ratel-mcp` CLI.

**Showcase ([`ratel-ai/ratel-mcp`](https://github.com/ratel-ai/ratel-mcp)).** The first canonical product on the library:

- **`@ratel-ai/mcp-server`** — exposes a `ToolCatalog` as an MCP server (`createMcpServer`) and builds gateways from a config (`buildGatewayFromConfig`), with OAuth 2.1 / PKCE support for HTTP and SSE upstreams. Ships as both a library and a `ratel-mcp` CLI (`mcp` / `serve` / `backup` verbs, Claude-Code import wizard). Released independently to npm. `@ratel-ai/cli` consumes the library half from there.

**Proof ([`ratel-ai/ratel-bench`](https://github.com/ratel-ai/ratel-bench)).** The benchmark harness — MetaTool agent campaign, ToolRet retrieval evaluation, three Ratel ablation arms across local / OSS / frontier models. Every accuracy / token / cost claim in this repo's README traces back to a row in [`RESULTS.md`](https://github.com/ratel-ai/ratel-bench/blob/main/RESULTS.md).

The library is the substrate; the showcase is the proof-by-construction that the substrate is enough; the benchmarks are the proof-by-measurement that the substrate moves the numbers.

## Where this is going

The wedge today is tool selection. The thesis is broader: **everything that ends up in an agent's context window is a retrieval problem.** Tools are the easiest case to start with — they're discrete, structured, and mid-cardinality. The same primitive extends to:

- **Skills** — registered alongside tools, ranked by the same algorithm, dispatched on demand. Skills are the "compose multiple tools to do X" abstraction; they belong on the same retrieval surface as the tools themselves. *(v0.1.x roadmap.)*
- **Memories** — prior context that should inform the current turn (a previous decision, a user preference, a saved artifact). Same retrieval question — what subset belongs in this turn's context — different content type. *(v0.2.x–v0.3.x.)*
- **Chat history** — long-running agents blow their context budget on past turns. Store, compact, prune, navigate. Retrieval over message history is the same primitive applied to a fourth content type. *(Later.)*

The end state is a **context graph**: tools, skills, memories, and message history live in one substrate, indexed together, ranked by what the current turn actually needs. Layered over the graph: telemetry that observes which retrievals worked, suggestions that improve the catalog over time (LLM-driven, fed by traces), and decomposition hints when one agent should hand off to another.

This is the longer arc. Today's product is the foundation: a catalog, a retrieval engine, four ways to use it. Each subsequent milestone widens the catalog's content types and tightens the loop between observation and improvement. None of it requires throwing away today's primitives — every new piece is a layer on the same core.

## What Ratel is not

- **Not a vector database.** Retrieval is deterministic BM25. No embedding pipeline.
- **Not a routing layer.** The model still picks the tool from the top‑K. Ratel decides what's *visible*, not what's *called*.
- **Not an agent framework — it plugs into yours.** Ratel doesn't run a tool loop, manage memory, or schedule turns. It hands you a `ToolCatalog` and gateway tools (`searchCapabilitiesTool`, `invokeToolTool`) that return generic `ExecutableTool` objects — wrap them into your framework's tool type and drop them in. The repo demonstrates the pattern with the Vercel AI SDK; the same wiring adapts to any TS agent framework you're already using.
- **Not a hosted service.** Today everything runs in your process. A self-hosted server flavor for telemetry consolidation is on the v0.2.x–v0.3.x roadmap; the SDK and MCP server stay in-process regardless.

## How Ratel relates to MCP

The Model Context Protocol is a transport / framing standard for tool-use between hosts and servers. Ratel is orthogonal: a retrieval engine that can sit on either side of an MCP boundary.

- **As an MCP client**: `registerMcpServer` lets a Ratel catalog ingest the tools an upstream MCP server advertises, alongside any local executables. The agent in your process gets one unified catalog regardless of where each tool actually runs.
- **As an MCP server**: `createMcpServer` wraps a catalog and exposes it over MCP — the connecting host (Claude Code, Cursor, ChatGPT) sees a small fixed set of tools (`search_capabilities` + `invoke_tool`, plus `get_skill_content` when skills are present), regardless of catalog size. This is the path the `ratel` CLI uses to put Ratel between Claude Code and your existing MCP servers.

You can use Ratel without MCP at all — register tools directly into a `ToolCatalog` from your TS / Rust agent and never touch the protocol.

## Locked decisions worth knowing

The architectural commitments that shape every piece of the codebase:

- [ADR‑0002 — TS↔Rust binding via NAPI-RS](adr/0002-ts-rust-binding-strategy.md). Why `@ratel-ai/sdk` ships pre-built natives and installs with no Rust toolchain.
- [ADR‑0003 — Tool selection: replace by default, suggest opt-in](adr/0003-tool-selection-replace-vs-suggest.md). The product behavior every other doc references.
- [ADR‑0004 — BM25 tool indexing strategy](adr/0004-bm25-tool-indexing.md). What gets tokenized, what gets stripped, why.
- [ADR‑0006 — Benchmark corpus and eval modes](adr/0006-benchmark-corpus-and-eval-modes.md). How we measure the retrieval claim.

ADRs are immutable once accepted — see [ADR‑0001](adr/0001-record-architecture-decisions.md) for the format and the why.
