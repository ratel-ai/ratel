# Changelog

All notable changes to `ratel-ai-core` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this crate adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.0-rc.1] - 2026-06-30

### Added

- **Dense (semantic) retrieval.** `search()` / `search_with_origin()` on both `ToolRegistry` and `SkillRegistry` rank by cosine similarity over embeddings of the tool/skill text, embedded with **`BAAI/bge-small-en-v1.5`** (384-dim, in-process Candle inference; CLS-pooled, L2-normalized, asymmetric query prefix). Weights are downloaded on first use and cached (~130 MB), never bundled. Embeddings are precomputed at `register()` and stored in-registry, index-aligned. See [ADR-0013](../../../docs/adr/0013-dense-semantic-retrieval.md).

### Changed

- `SearchHit.score` / `SkillHit.score` is now a cosine similarity (previously the BM25 score). The public `search()` / `search_with_origin()` signatures are unchanged — upgrading is transparent.
- New mandatory dependencies: `candle-core`, `candle-nn`, `candle-transformers`, `tokenizers`, `hf-hub` (pure-Rust inference; model fetched at runtime, not packaged).

## [0.2.0] - 2026-06-16

### Added

- First-class **skills**: a `Skill { id, name, description, tags, tools, metadata, body }` type and a separate `SkillRegistry` BM25 index — ranked independently of tools. Only `name`/`description`/`tags` are indexed; `tools` (a declared dependency edge surfaced at the gateway), `metadata` (non-indexed context such as `stacks`), and `body` are not. Plus `skill_search` / `skill_churn` / `skill_invoke` trace events for the retrieval funnel.

## [0.1.6] - 2026-06-10

### Changed

- Version bump for the coordinated v0.1.6 release (first release shipping the `ratel-ai` Python SDK). No crate source changes since 0.1.5; re-published in lockstep to keep all artifacts version-aligned.

## [0.1.5] - 2026-05-10

### Added

- Initial release on the v1 (revamp) line. BM25 tool retrieval, MCP ingestion, framework-neutral catalog. See the [crate README](README.md) for the full surface.
- `trace` module: `TraceEvent` tagged enum, `TraceEnvelope`, `TraceSink` trait with `NoopSink`, `MemorySink`, and `JsonlSink` (synchronous `O_APPEND`, mode `0600` on Unix) — single tagged event stream per [ADR-0009](../../../docs/adr/0009-trace-events-core-owned-schema.md). `ToolRegistry::with_trace_sink` / `set_trace_sink` / `record_event` plus a `search_with_origin` method. `register` emits `index_churn{Add}`; `search` emits `search` with a `bm25` stage. The origin enum tags each search as `direct` (Rust callers, pre-fetch helpers, benchmarks) or `agent` (LLM-synthesized via the gateway), to let downstream consumers separate the two paths.
