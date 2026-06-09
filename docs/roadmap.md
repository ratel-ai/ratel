# Roadmap

The wedge today is **tool selection**. Every milestone below layers onto the same primitives — a `ToolCatalog`, a retrieval engine, an in-process runtime — and widens what kinds of context the agent can resolve from.

For the architectural commitments behind each item, see [`docs/adr/`](adr/). For the broader thesis, see [`docs/overview.md`](overview.md).

This roadmap covers the **library** half of the project (this repo). The MCP-server **showcase** ([`ratel-ai/ratel-mcp`](https://github.com/ratel-ai/ratel-mcp)) and the benchmark **proof** ([`ratel-ai/ratel-bench`](https://github.com/ratel-ai/ratel-bench)) maintain their own roadmaps; library milestones below name the showcase / proof surfaces they unblock.

---

## Now (v0.1.4 — shipped 2026-05-05)

The first public release across all four registry artifacts.

- **`ratel-ai-core`** on crates.io — Rust library, BM25 tool retrieval.
- **`@ratel-ai/sdk`** on npm — TypeScript SDK with `ToolRegistry`, `ToolCatalog`, gateway tool factories, `registerMcpServer`. Pre-built native bindings for darwin-arm64, darwin-x64, linux-x64-gnu, linux-arm64-gnu, win32-x64-msvc.
- **`@ratel-ai/mcp-server`** on npm — library to expose a catalog as an MCP server, with OAuth 2.1 / PKCE for HTTP & SSE upstreams. Now hosted in the sibling [ratel-ai/ratel-mcp](https://github.com/ratel-ai/ratel-mcp) repo and released on its own cadence; this repo's CLI depends on it via npm.
- **`@ratel-ai/cli`** on npm — the `ratel` binary: one-shot import from Claude Code, add / serve / auth / list / edit / remove / link across three scopes.

## Next (v0.1.5)

The milestone in flight.

- **Telemetry + traces** on tool usage, end-to-end through `ratel-ai-core` → `@ratel-ai/sdk` and out through the MCP server. The substrate for the LLM-driven suggestions later in v0.1.x.
- **UI inspector** over the telemetry stream.
- **Benchmark MCP review** — exercise the published packages end-to-end through MCP, not just direct SDK wiring.

## Soon (rest of v0.1.x)

The catalog grows from tools-only to tools + skills, and the observation → improvement loop closes.

- **JSON → TOON encoding** — token-efficient serialization for tool inputs / outputs on the gateway path. Cuts per-call token spend without changing the catalog or the model contract.
- **Optional `tools/list_changed` notifications** behind a feature flag — so search-driven dispatch can update the live tool list dynamically while we measure which clients honor it reliably.
- **First-class skills** — register skills alongside tools, ranked by the same algorithm, dispatched on demand. The gateway unifies discovery into `search_capabilities` (a `tools` and a `skills` bucket) with `get_skill_content` to load a skill ([ADR‑0011](adr/0011-first-class-skills.md)).
- **Atoms / molecules / organisms** — organize skills + tools as a layered composition.
- **LLM-driven suggestions** — telemetry feeds an offline analyzer that proposes catalog improvements (better descriptions, missing parameters, redundant tools to merge, gaps to fill, brand-new skills to add). Surfaced in the inspector first.
- **Multi-agent decomposition suggestions** — when a single agent's catalog is too broad, surface the natural split points: which subsets of the catalog cluster around which workflows.
- **Apply + evaluate suggestions** — land suggested changes back into the registered catalog, with eval coverage so improvements don't regress.
- **Semantic search + re-ranking** — local embeddings first, then optional cloud; LLM and XGBoost re-rankers layered over BM25. BM25 stays the deterministic floor; semantic adds recall. Benchmark every combination (BM25 only / semantic only / hybrid / each + rerank).
- **Server flavor for trace consolidation** — opt-in self-hosted Rust server that aggregates traces across multiple agent instances. The SDK and MCP server stay in-process; the server is for teams running many agents.

## v0.2.x — chat management

Long-running agents blow their context budget on past turns. Same retrieval primitive, applied to message history.

- Store messages and retrieve the last N tokens.
- Compaction / summarization — local model first, then optional cloud (e.g. Compresr).
- Chat navigation tools.
- Smart pruning of tool inputs / outputs (replace with placeholders + a fetch tool).

## v0.3.x — memories

Prior context — decisions, preferences, artifacts — ranked into the current turn alongside tools and skills.

- Basic memory orchestration (mem0 or similar).
- Memories inform tool / skill selection and the suggestion loop.
- Chat history feeds memory consolidation (autodream-style).

## v0.4.x — context graph

The end state: tools, skills, and memories live in one graph. One substrate, multiple content types, one retrieval surface. Broader external-server integrations earn their keep here too.

## v0.5.x — Python SDK

Currently TS-only on the SDK side. Python is the next host language to bind the Rust core.

## Out of scope (for now)

- **Hosted multi-tenant runtime.** Ratel is in-process by design; the v0.1.x server flavor is opt-in self-hosted, not a SaaS.
- **Custom embedding models.** When semantic search lands, we'll integrate with existing providers (OpenAI, Voyage, local) rather than train our own.
- **Replacing the MCP protocol.** Ratel sits on either side of MCP boundaries. We're not redesigning the protocol; we're making the catalog primitive better.

---

This roadmap moves with the project. The README's "Where this is going" section mirrors the headlines from each horizon. If you spot a mismatch between this file and what's actually shipped, file an issue — the roadmap should track reality.
