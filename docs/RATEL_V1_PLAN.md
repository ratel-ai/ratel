# Ratel — v1 Plan

> Status: pre-spec working document. The formal PRD will follow once open decisions in §6 are closed.
> Repo (post-rebrand): `ratel-ai/ratel`.

## 1. Thesis

Ratel is the **Context Engineering platform for AI agents** — the layer that decides what ends up in an agent's context. v1's wedge is **smart tool selection and auth lifecycle**; chat/memory management is the next layer (v1.1+) so the trajectory is honest without overcommitting day one. Usable both as an in-process library and as a self-hostable server. One concrete integration is an MCP gateway, but the core is generic and works for agents that use internal APIs, function calls, or any tool surface — not just MCP servers.

The wedge is **usage-telemetry-driven, cross-session-learning tool selection**, not just RAG/vector-search-over-tool-descriptions. Auth lifecycle is table-stakes infrastructure that competitors in our tier don't ship, so we ship it.

**Lib vs server.** The library suffices for single-process agents (one long-running backend, a CLI tool). The server is what makes telemetry-driven selection and shared auth lifecycle work across fleets, serverless, and multi-instance deployments — exactly the shapes where lib-only collapses (cold starts wipe history; load-balanced instances fragment learning).

**The data flywheel.** Centralized telemetry → progressively smarter selection over time. v1 ships the data flywheel + a simple ranking model; v1.1/v1.2 explore more sophisticated approaches over the accumulated signal. We don't commit to an algorithm; we commit to the data being there so the exploration is possible.

## 2. Competitive landscape

The space splits into two tiers.

**OSS aggregator/gateway tier** — MetaMCP, MCP Router, Meta-MCP Tools Manager, Agent MCP Gateway, Meta MCP Proxy.
- Solves: aggregating multiple MCP servers behind one endpoint, namespaces, basic tool filtering, vector-search-based "smart" selection.
- Does **not** solve: refresh-token lifecycle (forwards auth, doesn't manage it), telemetry-driven selection, generic non-MCP tool support.

**Enterprise security-gateway tier** — Enkrypt Secure MCP Gateway, IBM ContextForge, Red Hat MCP Gateway, Bindify auth proxy.
- Solves: OAuth 2.1 lifecycle, proactive refresh, RFC 8693 token exchange, Vault integration, encrypted at-rest storage.
- Does **not** solve: smart tool selection — that is not the product.

**Ratel's positioning:** the combination of (a) telemetry-driven tool selection + (b) auth lifecycle + (c) generic-not-MCP-only is unoccupied. Validated externally — same ask came independently from a builder at a recent event.

## 3. Architecture

```
core/
  lib/                      # primary product surface (ratel-core crate), written in Rust
  server/                   # unlocks fleet/cross-session features (ratel-server) - for the developers this is an optional, basic features must work with lib only (shipped as a binary in the bundles, see below)

integrations/
  mcp-server/               # @ratel-ai/mcp-server: wraps core, exposes downstream MCPs over MCP
  cli/                      # @ratel-ai/cli with alias ratel: operator UX over local lib + remote server
  # future: openai-agents/, langchain/, vercel-ai-sdk/, ...

sdks/
  ts/                       # @ratel-ai/sdk (npm)
  py/                       # ratel-ai (PyPI)
```

**Library design — single lib, modular subpackages, `Backend` interface as the seam:**

```
@ratel-ai/sdk
├── tool-selection/    # local-only primitives
├── auth/              # token cache, refresh, vault adapters
├── telemetry/         # sink-agnostic event emission
├── context/           # RESERVED for v1.1: chat/conversation management (compaction, persistence, navigation across pruned messages). Empty in v1; the slot exists so the architecture is extensible without a breaking change.
├── backends/
│   ├── local.ts       # in-memory / SQLite (default)
│   └── remote.ts      # talks to ratel-server (opt-in)
└── index.ts
```

The lib's public API never branches on `if (server)`. It accepts an injected `Backend`. `LocalBackend` is default; `RemoteBackend` lights up cross-session learning, central token store, and fleet observability. Server-only features live in `@ratel-ai/sdk/server-features` as a subpath import; tree-shaking handles bundling.

**Naming for the wrapper tier:** `integrations/`. Doesn't collide with "gateway" (the role users assign to `ratel-mcp-server`) and extends naturally to non-MCP integrations.

## 4. Requirements

### 4.1 Functional — must work without the server (local lib only)

- **Auth lifecycle:** token cache, proactive refresh w/ jitter, refresh-on-401, vault/secrets-manager adapter. OAuth 2.1 *and* PATs/API keys (for internal-API agents).
- **Tool selection:** two-stage pipeline — stage 1 retrieval (algorithm per §6) → stage 2 reranking (per §6) → telemetry weighting layered on top. Top-K by final score, per-agent policy filter.
- **Telemetry emission** to a configurable sink (default: local SQLite or noop).
- **Tool-surface-agnostic:** equally usable for MCP and arbitrary function/API tools. The MCP integration is one consumer, not the abstraction.

**Explicit non-goal for v1:** the lib does not manage the conversation/chat history (compaction strategies, message persistence, agent navigation across pruned messages). That ships in v1.1. Architecture leaves room for it via the reserved `context/` module slot in §3 and the backwards-compatible `Backend` interface — so adding it later is additive, not a rewrite.

### 4.2 Functional — required by the server (modern deployment shapes)

These are the features lib-only cannot deliver in serverless, multi-instance, or fleet deployments. Each is a standalone reason to run the server — not "extras" you turn on once you've outgrown lib-only.

- **Central token vault with shared refresh.** Encrypted-at-rest token storage, *and* coordination so only one worker refreshes a given token (others read the new value). Solves refresh stampedes that lib-only literally cannot — when 20 workers hit a 401 simultaneously, they don't all race to rotate the token. Revoke-once-affects-all comes free with central storage.
- **Cross-session learning → tool selection that improves over time.** Aggregated usage signals (pick rate, success/fail rate, query→tool co-occurrence, recency-weighted usage by user/team) feed the ranking pipeline. The more your fleet uses Ratel, the smarter selection gets. Without the server, learning collapses to per-instance — useless for serverless and fragmented for multi-instance.
- **Central tool/MCP catalog (additive ops augmentation).** Tools/MCPs are declared in code by developers; the lib reflects them to the server via upsert with stable IDs. *Not* a separate registration step — same pattern as Terraform state or K8s manifests. The server is additive: ops can layer on tools that weren't declared in any single agent's code (e.g., "all our agents now have access to the new internal-search MCP"), and the lib pulls catalog + merges with local declarations. Code wins on conflicts by default.
- **Multi-agent / multi-tenant policy enforcement.** "Team X can use tool Y, team Z can't." Server-side because it's an ops decision, not a developer one — devs don't write that config in code anyway.
- **Fleet observability + audit log.** Central place to see what tools the fleet ran, which auth scopes were exercised, which failed. Required for compliance / SOC2 — lib-local audit logs are useless for that, scattered across whatever ephemeral compute ran the agent.

### 4.3 Functional — integrations

- **`ratel-mcp-server`:** wraps core, registers downstream MCPs, applies tool selection + auth, speaks MCP upstream.
- **`ratel-cli`:** register MCPs/tools, manage tokens, inspect telemetry, run server, debug.
- **TS + Python SDKs:** bundle local lib by default; opt into remote backend via env/config.

### 4.4 Non-functional

- **Local mode = zero infra dependencies.** SQLite or in-memory only.
- **Server self-hostable**, open-core, no SaaS lock-in.
- **Cold-start cost in local mode <50ms.** A CLI tool can't pay 500ms tax to load us. (Also caps how heavyweight the v1.1 `context/` module can be.)
- **Backwards-compatible `Backend` interface.** The right hook for adding the v1.1 chat/memory module without a breaking change.
- **Code is source of truth for tool/auth declarations; server reflects + augments.** No second config surface for developers — no UI/API to keep in sync with code. Tools, MCPs, and auth config are declared in code (or YAML alongside it); the lib upserts to the server using stable IDs on startup. Same pattern as Terraform state, Datadog-monitors-as-code, K8s manifests-and-controllers.
- **Embeddings run locally; no remote-API dependency at runtime.** The default tool-selection path is fully self-contained. Internal `Embedder` trait exists as a seam for a future cloud version to swap in fine-tuned models, but **no external override is exposed in v1** — keeps the surface tight and forces real user feedback before exposing knobs. Remote-API embedders (OpenAI, Cohere) deferred until a customer asks.

## 5. Locked technical decisions

| Layer | Choice | Rationale |
|---|---|---|
| Server language | **Rust** (existing) | Working baseline; latency-critical inline path; sqlx/rusqlite ecosystem solid |
| Server storage default | **SQLite** (single file) | Consistent with "no infra deps" principle; cheap to operate at our ICP's scale |
| Vector index | **sqlite-vector** ([sqlite.ai](https://www.sqlite.ai/sqlite-vector)) | Vector search inside SQLite. License terms + Rust loadable-extension distribution to confirm in Phase 0 (ADR 0003); fallback to sqlite-vec if blocked |
| Lexical index | **SQLite FTS5** (paired with sqlite-vector) | Both ship by default to support hybrid retrieval; final mix locked in §6. If §6 lands on pure BM25, sqlite-vector drops; if pure vector, FTS5 drops. Cheap to ship both — they coexist in the same SQLite file |
| Embeddings | **Local only**, via **fastembed-rs** (Rust ONNX bindings) | Bundled into binary distributions (~80MB), lazy-downloaded by SDKs on first use; no remote-API option in v1 (deferred until a customer asks). Internal `Embedder` trait keeps the seam open for a future cloud version to swap in fine-tuned models transparently. Specific model chosen in the §6 #6 spike from a local shortlist (BGE-small / MiniLM / GTE-small / jina). Fallback to Candle if fastembed-rs blocks the chosen model |
| External DB (Postgres etc.) | **Deferred** | Keep queries modular but don't abstract speculatively. Add when a real user can't live without it |
| Lib local-mode storage | **SQLite** (or in-memory for ephemeral) | Same engine as server — consistent operator experience |
| SDK languages day one | **TS first, Python second** | MCP ecosystem is TS-heavy; Python is the agent default |

**Watch-out:** SQLite is single-writer. At high telemetry-write throughput this becomes the forcing function for Postgres. Mitigation: batch writes client-side (lib already buffers) + write-ahead queueing on the server. Buys significant runway.

## 6. Open decisions (lock before formal PRD)

1. **Server transport.** MCP-native + REST control plane vs pure REST/SSE.
2. **Tool selection — replace vs suggest.** Does the lib *replace* the agent's tool-list (more powerful, less compatible) or *suggest a ranked subset* (more compatible, less leverage)? Possibly configurable.
3. **Auth storage encryption** — AEAD with deployment-provided key (mirroring ContextForge/Enkrypt). Confirm v1 floor.
4. **RFC 8693 token exchange** — v1 or v2.
5. **TS↔Rust binding strategy** — NAPI vs WASM vs FFI vs HTTP-only. Affects Phase 2 timing.
6. **Tool selection — retrieval method, embedding model, and reranker choice.** The two-stage architecture (retrieve → rerank) and the embedding architecture (local-only via fastembed-rs, no external override in v1, internal trait for future cloud) are both locked; only the algorithms remain open. Stage 1: BM25 only / vector only / hybrid (BM25 + vector — modern default). Embedding model: pick from local shortlist (BGE-small-en-v1.5 / all-MiniLM-L6-v2 / GTE-small / jina-embeddings-v2-small-en) via the spike (§6.6 in Phase 0 doc). Stage 2: LLM-as-reranker (small model like Haiku) vs purpose-built reranker (Cohere Rerank, BGE-reranker, etc.) — tradeoff is latency, $/call, and external-API dependency. Also: where telemetry enters the pipeline — stage 1 score boost / stage 2 reranker input / stage 3 post-rerank reorder, or some combination. Cost/latency hook: selection should likely run once per agent task/invocation (selected tools cached for the task lifetime), not per turn — interacts with decision 2 and the <50ms cold-start budget in §4.4.

## 7. Demo angle

This is the **builder demo** — for agent-builders evaluating Ratel as a dependency. Single agent file, three diff hunks:

1. **Before:** plain agent, all 40 tools loaded into context, hardcoded auth tokens.
2. **+ Ratel local lib (one import):** tools auto-ranked top-8, auth tokens auto-refreshed via vault adapter. No server. Works for any tool surface, MCP or not.
3. **+ Ratel remote backend (flip one env var):** same agent now emits telemetry to your Ratel server. A second agent on the same user benefits from the first's learning.

This sells the generic-agent thesis *and* the MCP-gateway product in the same flow — step 2 already works for any tool, step 3 is what an MCP gateway operator wants.

**Operator-facing value sells separately**, not via this demo: central token vault with shared refresh, catalog management, audit log. Different audience (ops / eng-manager), different demo. Don't try to cram those into the builder flow — refresh stampede prevention isn't visually demoable, and catalog management is an admin concern, not a builder concern.

---

# Implementation Plan

## Branching strategy

We're already on a `revamp` branch off the existing prototype's `main`. **All Phase 0–7 work lands on `revamp`**; `main` stays untouched as the live v0 codebase until the very end, so we don't throw away the prototype prematurely.

The `revamp → main` cutover happens **after Phase 7 ships**. We'll lock the exact mechanics (tag `main` as `v0-archive`; reset `main` to `revamp`'s tip vs. fast-forward merge; squash vs. preserve history) closer to that point — by then the revamp history's shape will tell us the cleanest path. For now: keep working on `revamp`, don't touch `main`.

Each phase produces something demoable, testable, or unblocking. Effort estimates assume 2 people, half-time.

## Phase 0 — Scaffold & lock open decisions (3-5 days)

**Goal:** Repo structure exists, CI runs, decisions in §6 are closed.

**Scope:**
- Repo layout: `core/`, `integrations/`, `sdks/`, `docs/`
- Cargo workspace (`ratel-core`, `ratel-server`, `ratel-mcp-server`, `ratel-cli`); pnpm workspace for `@ratel-ai/sdk`
- CI baseline: build + lint + test on PR for both languages
- ADRs in `docs/adr/` capturing: Rust+SQLite, Backend interface, integrations naming, server transport, replace-vs-suggest, binding strategy, retrieval-and-reranker choice, **v1 scope** (tool selection + auth + telemetry; chat/memory deferred to v1.1; server justified by modern deployment shapes), **catalog/config ownership** (code-as-source-of-truth with server reflection)
- README + landing copy on Ratel positioning

**Decisions to lock before exiting Phase 0:** all six from §6.

**Out of scope:** any actual functionality.

## Phase 1 — Core lib, local mode (1-2 weeks)

**Goal:** `ratel-core` runnable from a Rust test harness with no server. Auth refresh and tool selection both work end-to-end against a fixture set of tools.

**Scope:**
- `Backend` trait + `LocalBackend` (SQLite + sqlite-vector + FTS5)
- `Embedder` trait + `LocalEmbedder` via fastembed-rs; specific model chosen in §6 #6 spike. Bundled into the Rust binary; SDKs lazy-download on first use. No external override exposed in v1.
- `auth/` module: token cache, proactive refresh w/ jitter, refresh-on-401, vault adapter trait
- `telemetry/` module: event emission to a `Sink` (default: SQLite, noop available)
- `tool-selection/` module: two-stage pipeline — stage 1 retrieval per §6 decision, stage 2 reranking per §6 decision. Telemetry weighting wired in but trivial; the wedge ranking lands in Phase 6.
- Port from `v0-archive`: SQLite schema, refresh logic, vector-index code, any tests worth keeping
- Integration tests covering the full local-mode path

**Out of scope:** non-Rust SDKs; the server; cross-session anything.

**Demoable end state:** Rust binary that loads tools, ranks top-K for a query, refreshes OAuth tokens before expiry.

## Phase 2 — TS SDK + MCP integration (1-2 weeks)

**Goal:** Demo steps 1+2. A real TS agent goes from "all 40 tools loaded, hardcoded auth" → "one Ratel import, top-8 ranked tools + auto-refresh."

**Scope:**
- `@ratel-ai/sdk`: TS bindings to `ratel-core` via the strategy chosen in Phase 0
- `ratel-mcp-server`: wraps core, registers downstream MCPs from config, applies tool selection + auth, speaks MCP upstream
- E2E test: TS agent → `ratel-mcp-server` → 2-3 downstream MCPs (Linear, GitHub, filesystem as fixtures)
- Demo script + recording of steps 1→2

**Out of scope:** Python SDK, server, cross-session learning, CLI.

**Demoable end state:** Steps 1+2 of the demo. This is the *minimum interesting thing* — already validates the generic-agent thesis and the MCP gateway product.

## Phase 3 — Server + RemoteBackend (1-2 weeks)

**Goal:** Demo step 3. Flip an env var, agent emits telemetry to `ratel-server`, second agent benefits.

**Scope:**
- `ratel-server`: thin Rust server, SQLite storage, REST control plane, MCP-native tool path (per Phase 0 decision)
- `RemoteBackend` in `ratel-core` — same `Backend` interface, talks to server
- Telemetry forwarding from local → remote with batching/buffering
- Basic cross-session learning: tool-selection reads aggregated usage signals when `RemoteBackend` is in use
- **Central token vault with shared refresh** — encrypted storage *and* coordination (one worker refreshes, others read the new value). Solves refresh stampedes; revoke-once-affects-all comes free with central storage. Not just remote SQLite for tokens — it's a coordination point.
- **Tool/MCP catalog as server-side reflection of code-declared state.** Lib upserts on startup with stable IDs; server stores the reflection plus any ops-added augmentations. *No separate registration step* — developers don't touch a UI before deploying. (Catalog augmentation API for ops can ship here or be deferred to Phase 4 with the CLI work — decide during Phase 0.)
- AuthN on server: simple bearer token for v1 (full OAuth on the server's *own* surface is v2)

**Out of scope:** multi-tenant policies, RFC 8693, fleet observability dashboards.

**Demoable end state:** Full 3-step demo runs.

## Phase 4 — CLI + DX (3-5 days)

**Goal:** A human can operate Ratel without reading the source.

**Scope:**
- `ratel-cli`: register/list MCPs and tools, view telemetry, inspect tokens, run server, debug
- Hot config reload (file-watched)
- Decent error messages for common failures (expired tokens, unreachable MCP, schema mismatch)
- Quickstart docs: "from zero to running Ratel in 5 minutes"

**Out of scope:** TUI, advanced filtering, remote-server admin UI.

## Phase 5 — Python SDK (1 week)

**Goal:** Parity with TS SDK so Python-first agent builders aren't blocked.

**Scope:**
- `ratel` PyPI package (PyO3 bindings or HTTP-based thin client per Phase 0 binding decision)
- Same public surface as `@ratel-ai/sdk` where possible
- Example agent (LangChain or plain Anthropic SDK) wired up identically to the TS demo

**Out of scope:** anything Python-framework-specific (LangChain plugins, etc.) — those become future `integrations/`.

## Phase 6 — Telemetry-weighted selection (1-2 weeks) — *the differentiation*

**Goal:** The two-stage pipeline (retrieve → rerank) gets telemetry-weighted at the entry point per §6 decision (stage 1 score boost / stage 2 reranker input / stage 3 post-rerank reorder). Cross-session signals make the ranking meaningfully smarter than "retrieve + rerank on descriptions alone." This is the wedge.

**This is also where the server's value proposition becomes visible** — without cross-instance aggregation, telemetry-weighted selection degrades to single-process learning only, which is useless for serverless and fragmented for multi-instance.

**Scope:**
- Define ranking signals: pick rate, success rate, fail rate by tool, recency-weighted usage by user/team, query→tool co-occurrence
- Telemetry-weighting integration into the two-stage pipeline (per §6 decision on entry point); start simple — weighted boosts/biases, tunable, no ML day one
- A/B harness so we can measure relevance against a held-out query set
- Telemetry → ranking feedback loop (server-side aggregation)
- Document the ranking algorithm — this is part of the marketing story

**Out of scope:** ML-trained ranking, RL, custom reranker fine-tuning — those belong to the v1.1/v1.2 selection-quality research track.

## Phase 7 — Hardening + v1 launch prep (1 week)

**Goal:** Ship-ready.

**Scope:**
- Encrypted-at-rest token storage (deployment-provided key)
- Audit log on the server
- Docker/compose deployment for self-host
- Public docs + landing page
- **`revamp → main` cutover** — tag current `main` as `v0-archive`, promote `revamp` to `main`. Exact mechanics (reset vs. merge, squash vs. preserve history) decided at this point based on the actual revamp history.
- Soft launch: 2-3 places where the agent-builder audience hangs out, recruit 5 design partners

## Deferred to v1.1 / v2

- RFC 8693 token exchange (downscoped per-server tokens)
- Multi-tenant policy enforcement
- Fleet observability dashboards
- Postgres backend (add when the first user demands it)
- LangChain / OpenAI Agents / Vercel AI SDK integrations
- **Chat / context management** — compaction strategies, message persistence, agent navigation across pruned/compacted history. Populates the reserved `context/` module slot in §3.
- **Cross-compaction memory consolidation** — once chat management ships, history becomes the substrate for consolidating memories across compaction boundaries.
- **MCP-exposed memory + history-recall tools** — "remember X across compactions," "recall from history" exposed as MCP tools (in addition to SDK). Compounds with the memory work; not chat management proper, but adjacent and shippable separately.
- **Selection-quality research track (v1.1/v1.2)** — formerly "ML-trained tool selection." We commit to the data flywheel in v1; specific algorithms evolve over the accumulated telemetry. Candidates: ML-trained ranking, RL on outcome signals, query→tool co-occurrence models, custom reranker fine-tuning. We don't pick now; we keep the data so we can pick later.

## Critical-path summary

```
Phase 0 → Phase 1 → Phase 2 → DEMO-ABLE (steps 1+2)
                       ↓
                    Phase 3 → DEMO-ABLE (full 3 steps) → soft launch possible
                       ↓
                Phase 4 + 5 (parallelizable)
                       ↓
                    Phase 6 → DIFFERENTIATION VISIBLE
                       ↓
                    Phase 7 → v1 launch
```

**Estimated total to v1:** ~10–12 weeks part-time for 2 people.
**First demo-able state (steps 1+2):** ~3–4 weeks.

That early demo is the artifact to take to the next event so the conversation stops being hypothetical.
