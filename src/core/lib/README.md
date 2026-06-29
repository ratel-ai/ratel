<div align="center">
  <h1>ratel-ai-core</h1>
  <h4>Rust core for Ratel — hybrid retrieval over an agent's tool catalog, in-process, no infra.</h4>

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

Tools are the first content type indexed by the core. Each `Tool` is projected to a deterministic flat text — its `name`, `description`, and a walk of both `input_schema` and `output_schema`. Only semantic tokens (property names, descriptions, enum values) are emitted; JSON Schema structure (`type`, `required`, `$ref`, braces, quotes) is skipped. See [ADR‑0004](../../../docs/adr/0004-bm25-tool-indexing.md) for the algorithm and rationale. That same flat text is what every retrieval stage consumes.

`Skill` is the second content type, ranked through `SkillRegistry`. A skill is indexed over its `name`, `description`, and `tags` (author-declared labels and task phrases); its `tools` (declared tool-id dependencies, surfaced at the gateway), `metadata` (non-indexed context such as `{"stacks": ["react"]}` for the push-path ranker), and `body` (the dispatch payload) are not indexed. See [ADR‑0012](../../../docs/adr/0012-first-class-skills.md). The same retrieval engine carries forward to memories and message history as those land on the [roadmap](../../../docs/roadmap.md).

## Hybrid retrieval

`search()` runs a hybrid pipeline ([ADR‑0013](../../../docs/adr/0013-hybrid-retrieval.md)): BM25 (lexical) and a dense embedding arm (semantic) each rank the corpus, **Reciprocal Rank Fusion** (`k = 60`) merges the two rankings, and a **cross-encoder reranker** scores the fused candidate pool to produce the final order. BM25 is precise where query and tool share words; the dense arm recovers the "missing gold" cases where they describe the same thing in different words ("remove a file" vs. "delete a path"); the cross-encoder, which reads the `(query, tool)` pair jointly, tightens precision over either alone.

- **Dense embedder:** `BAAI/bge-small-en-v1.5` (384-dim, CLS-pooled, L2-normalized, asymmetric query prefix). Each tool/skill is embedded once at `register()`; a query embeds only the query string. Vectors live in-registry (`Vec<Vec<f32>>`), index-aligned — no vector DB; brute-force cosine.
- **Cross-encoder:** `cross-encoder/ms-marco-MiniLM-L6-v2`, run only over the bounded fused pool (query-time, never at registration). `SearchHit.score` is its relevance logit (unbounded; can be negative).
- **Pure-Rust [Candle](https://github.com/huggingface/candle)** inference, CPU + f32, **pinned model revisions** — deterministic across machines. Weights are **downloaded on first use** into `~/.cache/huggingface` (~220 MB across both models) and cached, never bundled; offline after the first fetch.

The public `search()` / `search_with_origin()` signatures are unchanged from the BM25-only releases — upgrading gets hybrid transparently. Each pipeline phase is recorded as a `SearchStage` (`bm25`, `dense`, `rrf`, `rerank`) on the trace event.

> First run needs network to fetch the models. `cargo test -p ratel-ai-core` downloads them once; CI should cache `~/.cache/huggingface`.

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
