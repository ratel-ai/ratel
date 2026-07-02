<div align="center">
  <h1>ratel-ai-core</h1>
  <h4>Rust core for Ratel — dense (semantic) retrieval over an agent's tool catalog, in-process, no infra.</h4>

  <p>
    <a href="../../../docs/">Docs</a> •
    <a href="../../../docs/roadmap.md">Roadmap</a> •
    <a href="https://discord.gg/hdKpx69NR">Discord</a>
  </p>

  <p>
    <a href="https://crates.io/crates/ratel-ai-core"><img src="https://img.shields.io/crates/v/ratel-ai-core?label=crates.io&color=e57300" alt="crates.io" /></a>
    <a href="https://docs.rs/ratel-ai-core"><img src="https://img.shields.io/docsrs/ratel-ai-core?label=docs.rs" alt="docs.rs" /></a>
    <a href="https://github.com/ratel-ai/ratel/stargazers"><img src="https://img.shields.io/github/stars/ratel-ai/ratel?style=social" alt="GitHub stars" /></a>
    <a href="https://discord.gg/hdKpx69NR"><img src="https://img.shields.io/discord/1478702964003705015?logo=discord&logoColor=white&color=7289da&label=discord" alt="Discord" /></a>
    <a href="../../../LICENSE.md"><img src="https://img.shields.io/badge/license-MIT-blue" alt="license" /></a>
  </p>
</div>

The Rust library at the heart of Ratel. Retrieval, auth, and telemetry are implemented here; every other piece of the project (SDKs, benchmark, future server and integrations) is a wrapper around this crate.

## Library shape

- Crate name: `ratel-ai-core`
- Library name: `ratel_ai_core`
- In-process; no infra dependencies
- Member of the root Cargo workspace

## Build & test

From the repo root:

```bash
cargo build -p ratel-ai-core
cargo test  -p ratel-ai-core
cargo clippy -p ratel-ai-core --all-targets -- -D warnings
```

Or run against the whole workspace from the repo root with `cargo build --workspace` / `cargo test --workspace`.

## What gets indexed

Tools are the first content type indexed by the core. Each `Tool` is projected to a deterministic flat text — its `name`, `description`, and a walk of both `input_schema` and `output_schema`. Only semantic tokens (property names, descriptions, enum values) are emitted; JSON Schema structure (`type`, `required`, `$ref`, braces, quotes) is skipped. See [ADR‑0004](../../../docs/adr/0004-bm25-tool-indexing.md) for the projection algorithm. That same flat text is what dense retrieval embeds (below).

`Skill` is the second content type, ranked through `SkillRegistry`. A skill is projected over its `name`, `description`, and `tags` (author-declared labels and task phrases); its `tools` (declared tool-id dependencies, surfaced at the gateway), `metadata` (non-indexed context such as `{"stacks": ["react"]}` for the push-path ranker), and `body` (the dispatch payload) are not indexed. See [ADR‑0012](../../../docs/adr/0012-first-class-skills.md).

## Dense (semantic) retrieval

In this version, `.search()` on `ToolRegistry` and `SkillRegistry` **is** dense retrieval — it embeds the flat text above with a local BERT-family sentence model run in-process via [Candle](https://github.com/huggingface/candle) (the specific model is the per-version experiment variable — this version uses `all-MiniLM-L6-v2`) and cosine-ranks an embedded query against it (emitting the trace schema with a `"dense"` stage). Vectors are precomputed at `register()`. The model is **downloaded on first use** (via `hf-hub`, at a pinned revision) into the shared HuggingFace cache (`~/.cache/huggingface`) and loaded from cache thereafter — offline after the first fetch, deterministic because the revision is pinned. It is loaded once per process and serves both registration and queries.

There is no separate `search_dense` method and no feature flag: dense is the engine. The lexical (BM25) baseline is an **earlier version** of this crate — the retrieval method is selected by version, so the benchmark compares engines by swapping the `ratel-ai-core` version alone. See [ADR‑0013](../../../docs/adr/0013-dense-semantic-retrieval.md).

```bash
cargo test -p ratel-ai-core   # first run downloads the model (~130 MB) into the HF cache
```

### Failure handling & footprint

`register()` and `search()` are **fallible**. The first-use model load can fail — no network/DNS, an unwritable cache, or corrupt weights — and is surfaced as a typed `EmbedderError` carrying a remediation hint (raised as a catchable exception in the SDKs) rather than aborting the process. A failed load is **not cached**, so a later call retries once the cause clears. `HF_HOME` (cache location) and `HF_ENDPOINT` (mirror / offline proxy) are honored via `hf-hub`.

The resident model is ~130 MB of f32 weights and inference is CPU-only, so an underpowered machine loads and embeds slowly. A slow cold load emits a `TraceEvent::EmbedderLoad { status: "slow", .. }` flag (threshold overridable via `RATEL_EMBED_SLOW_MS`, default 5000 ms) and logs a one-line warning; running out of memory is an uncatchable OS kill, which no flag can intercept.

## Trace stream

Every layer of Ratel — core, SDK, mcp-server — emits into a single tagged event stream owned by this crate ([ADR‑0009](../../../docs/adr/0009-trace-events-core-owned-schema.md)). One stream, multiple consumers (inspector, suggestion analyzer, future rerankers and consolidation server), filtered at the consumer.

```rust
use std::sync::Arc;
use ratel_ai_core::{JsonlSink, ToolRegistry, TraceEvent};

let sink = Arc::new(JsonlSink::new("session-1", "/tmp/ratel.jsonl")?);
let mut registry = ToolRegistry::with_trace_sink(sink);
registry.register(my_tool);
let _ = registry.search("read a file", 5);
// every `register` and `search` is now appended as one JSON line.
```

Built-in sinks:
- `NoopSink` — default; drops everything.
- `MemorySink` — `Vec`-backed for tests and embedder assertions (`snapshot()`, `drain()`).
- `JsonlSink` — synchronous `O_APPEND` per event, mode `0600` on Unix.

Schema: `TraceEvent` is a tagged enum (search, index_churn, skill_search, skill_churn, skill_invoke, invoke_*, gateway_*, upstream_*, auth_*) wrapped in `TraceEnvelope { v, ts, session_id, ...event }`. The reliability profile is **query-log shaped** — best-effort, sampleable, lossy on backpressure. See ADR-0009 for the full rationale.

The custom `TraceSink` trait lets embedders forward events to their own pipeline (HTTP, structured logger, ring buffer). The trait carries a `sample_rate()` knob (defaulting to `1.0`); the rate-limiter implementation is deferred to a later release.
