# Roadmap

This is the canonical roadmap. It supersedes the old `plan.md` / `progress.md` references in earlier READMEs (those files were gitignored working notes and not visible to external readers).

The wedge today is **tool selection**. Every milestone below layers onto the same primitives — a `ToolCatalog`, a retrieval engine, an in-process runtime — and widens what kinds of context the agent can resolve from.

For the architectural commitments behind each item, see [`docs/adr/`](adr/). For the broader thesis, see [`docs/overview.md`](overview.md).

---

## Now (v0.1.4 — shipped 2026-05-05)

The first public release across all four registry artifacts.

- **`ratel-ai-core`** on crates.io — Rust library, BM25 tool retrieval.
- **`@ratel-ai/sdk`** on npm — TypeScript SDK with `ToolRegistry`, `ToolCatalog`, gateway tool factories, `registerMcpServer`. Pre-built native bindings for darwin-arm64, darwin-x64, linux-x64-gnu, linux-arm64-gnu, win32-x64-msvc.
- **`@ratel-ai/mcp-server`** on npm — library to expose a catalog as an MCP server, with OAuth 2.1 / PKCE for HTTP & SSE upstreams.
- **`@ratel-ai/cli`** on npm — the `ratel` binary: one-shot import from Claude Code, add / serve / auth / list / edit / remove / link across three scopes.

## Soon (v0.1.x)

Layering on the v0.1.4 surface — same primitives, more reach.

- **Telemetry + UI inspector** — observe which tools the agent calls, which `search_tools` queries returned which hits, what the model chose vs. what was offered. The substrate for the LLM-driven suggestions in v0.2.x.
- **JSON → TOON encoding** — token-efficient serialization for tool inputs / outputs on the gateway path. Cuts per-call token spend without changing the catalog or the model contract.
- **First-class skills** — register skills (composed flows) alongside tools, ranked by the same algorithm, dispatched on demand. The catalog grows from a tools-only object to a tools+skills object; `search_tools` and `invoke_tool` extend without breaking changes.

## Mid (v0.2.x – v0.3.x)

The observation→improvement loop closes.

- **LLM-driven tool / skill suggestions** — telemetry feeds an offline analyzer that proposes catalog improvements (better descriptions, missing parameters, redundant tools to merge, gaps to fill).
- **Multi-agent decomposition suggestions** — when a single agent's catalog is too broad, surface the natural split points: which subsets of the catalog cluster around which workflows.
- **Semantic search + re-ranking** — local + optional cloud embeddings, with LLM and XGBoost re-ranking layered over BM25. BM25 stays the deterministic floor; semantic adds recall.
- **Server flavor for trace consolidation** — a self-hosted Rust server that aggregates traces across multiple agent instances. The SDK and MCP server stay in-process; the server is opt-in for teams running many agents.

## Later

Widening the catalog's content types and integrating with the rest of the agent runtime.

- **Chat management** — store / compact / prune / navigate message history. Retrieval over past turns is the same primitive applied to a different content type.
- **Memories integration** — prior context (decisions, preferences, artifacts) ranked into the current turn alongside tools and skills.
- **Unified tools-skills-memories graph** — the **context graph**. One substrate, four content types, one retrieval surface.
- **Python SDK** — currently TS-only on the SDK side. Python is the most-requested target after the v0.1.x release.

## Out of scope (for now)

- **Hosted multi-tenant runtime.** Ratel is in-process by design; the v0.2.x–v0.3.x server flavor is opt-in self-hosted, not a SaaS.
- **Custom embedding models.** When semantic search lands, we'll integrate with existing providers (OpenAI, Voyage, local) rather than train our own.
- **Replacing the MCP protocol.** Ratel sits on either side of MCP boundaries. We're not redesigning the protocol; we're making the catalog primitive better.

---

This roadmap moves with the project. The README's "What's coming" section mirrors the headlines from each horizon. If you spot a mismatch between this file and what's actually shipped, file an issue — the roadmap should track reality.
