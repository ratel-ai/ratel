<div align="center">
  <h1>ratel-ai-core</h1>
  <h4>Rust core for Ratel — selectable BM25, semantic, or hybrid retrieval over an agent's tool catalog, in-process, no infra.</h4>

  <p>
    <a href="../../docs/">Docs</a> •
    <a href="https://discord.gg/hdKpx69NR">Discord</a>
  </p>

  <p>
    <a href="https://crates.io/crates/ratel-ai-core"><img src="https://img.shields.io/crates/v/ratel-ai-core?label=crates.io&color=e57300" alt="crates.io" /></a>
    <a href="https://docs.rs/ratel-ai-core"><img src="https://img.shields.io/docsrs/ratel-ai-core?label=docs.rs" alt="docs.rs" /></a>
    <a href="https://github.com/ratel-ai/ratel/stargazers"><img src="https://img.shields.io/github/stars/ratel-ai/ratel?style=social" alt="GitHub stars" /></a>
    <a href="https://discord.gg/hdKpx69NR"><img src="https://img.shields.io/discord/1478702964003705015?logo=discord&logoColor=white&color=7289da&label=discord" alt="Discord" /></a>
    <a href="../../LICENSE-APACHE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="license" /></a>
  </p>
</div>

The Rust library at the heart of Ratel. Retrieval, auth, and telemetry are implemented here; every other piece of the project (SDKs, benchmark, integrations) is a wrapper around this crate.

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

Tools are the first content type indexed by the core. Tool search ranks a deterministic flat-text projection of each `Tool`: its `name`, `description`, and a walk of both `input_schema` and `output_schema`. Only semantic tokens (property names, descriptions, enum values) are emitted; JSON Schema structure (`type`, `required`, `$ref`, braces, quotes) is skipped. See [ADR‑0004](../../docs/adr/0004-retrieval-and-tool-selection.md) for the algorithm and rationale.

`Skill` is the second content type, ranked by the same engines through `SkillRegistry`. A skill is indexed over its `name`, `description`, and `tags` (author-declared labels and task phrases); its `tools` (declared tool-id dependencies, surfaced via `search_capabilities`), `metadata` (non-indexed context such as `{"stacks": ["react"]}` for the push-path ranker), and `body` (the dispatch payload) are not indexed. See [ADR‑0005](../../docs/adr/0005-first-class-skills.md). The same retrieval primitive carries forward to memories and message history as those land.

## Retrieval methods

A `SearchMethod` selects the ranker — `Bm25` (default), `Semantic`, or `Hybrid` — per registry (a construction-time default) or per call via `search_with_method`. `search` / `search_with_origin` keep their infallible BM25 behavior unchanged.

- **BM25** — lexical, model-free, the default. Never fails, never loads a model.
- **Semantic** — dense cosine ranking over a local `BAAI/bge-small-en-v1.5` embedding (pure-Rust Candle; fetched once into the HuggingFace cache on first use).
- **Hybrid** — BM25 and dense arms fused by Reciprocal Rank Fusion (no reranker).

Semantic/hybrid load the model when embeddings are first built (eagerly at `register` in semantic/hybrid mode), never at install and never inside a search — a BM25-only registry never touches it — and `search_with_method` returns `Result<_, EmbedderError>` so a failed load (network / cache / underpowered machine) is catchable. See [ADR‑0011](../../docs/adr/0011-selectable-retrieval-methods.md).

## Trace stream

Every layer of Ratel — core, SDK, mcp-server — emits into a single tagged event stream owned by this crate ([ADR‑0007](../../docs/adr/0007-telemetry-two-streams.md)). One stream, multiple consumers (inspector, suggestion analyzer, future rerankers and consolidation server), filtered at the consumer.

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

Schema: `TraceEvent` is a tagged enum (search, index_churn, skill_search, skill_churn, skill_invoke, invoke_*, gateway_*, upstream_*, auth_*) wrapped in `TraceEnvelope { v, ts, session_id, ...event }`. The reliability profile is **query-log shaped** — best-effort, sampleable, lossy on backpressure. See ADR-0007 for the full rationale.

The custom `TraceSink` trait lets embedders forward events to their own pipeline (HTTP, structured logger, ring buffer). The trait carries a `sample_rate()` knob (defaulting to `1.0`); the rate-limiter implementation is deferred to a later release.
