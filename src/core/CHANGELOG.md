# Changelog

All notable changes to `ratel-ai-core` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this crate adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.0-rc.1] - 2026-07-06

### Added

- **Selectable retrieval methods** (ADR-0011): a `SearchMethod` enum — `Bm25` (default), `Semantic`, `Hybrid` — chosen per registry or per call via `ToolRegistry::search_with_method` / `SkillRegistry::search_with_method`. Semantic ranks a local `BAAI/bge-small-en-v1.5` embedding (pure-Rust Candle); hybrid fuses the BM25 and dense arms with Reciprocal Rank Fusion (no reranker).
- `EmbedderError` (surfaced from `search_with_method` on the semantic/hybrid path) and a `TraceEvent::EmbedderLoad` / `EmbedderLoadStatus` flagging a slow (possibly underpowered machine) or failed model load.
- `ToolRegistry::warm` / `SkillRegistry::warm` — pre-compute embeddings for not-yet-embedded tools/skills so a later semantic/hybrid search only embeds the query.

### Changed

- BM25 remains the default engine. `search` / `search_with_origin` keep their infallible `Vec<SearchHit>` signature and BM25 behavior unchanged.
- The dense embedding cache is now **incremental** — a growing prefix of the corpus. `register` only appends (never invalidates), and `warm` embeds only newly-registered tools, so an existing vector is never recomputed (adding one tool costs one embedding, not N). A BM25-only registry still never loads the model.
- A semantic/hybrid search over an un-warmed corpus now returns `EmbedderError::NotWarmed` instead of embedding inside the search path — a search never silently pays the corpus-embedding cost. Populate the cache with `warm()` first.

## [0.2.1-rc.1] - 2026-07-04

### Changed

- First release cut under the per-package release scheme (ADR-0016): `ratel-ai-core` now versions and ships independently, tagged `core-v*`. No crate API changes since 0.2.0.

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
