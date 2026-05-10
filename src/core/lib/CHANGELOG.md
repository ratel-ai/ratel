# Changelog

All notable changes to `ratel-ai-core` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this crate adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.5] - 2026-05-10

### Added

- Initial release on the v1 (revamp) line. BM25 tool retrieval, MCP ingestion, framework-neutral catalog. See the [crate README](README.md) for the full surface.
- `trace` module: `TraceEvent` tagged enum, `TraceEnvelope`, `TraceSink` trait with `NoopSink`, `MemorySink`, and `JsonlSink` (synchronous `O_APPEND`, mode `0600` on Unix) — single tagged event stream per [ADR-0009](../../../docs/adr/0009-trace-events-core-owned-schema.md). `ToolRegistry::with_trace_sink` / `set_trace_sink` / `record_event` plus a `search_with_origin` method. `register` emits `index_churn{Add}`; `search` emits `search` with a `bm25` stage. The origin enum tags each search as `direct` (Rust callers, pre-fetch helpers, benchmarks) or `agent` (LLM-synthesized via the gateway), to let downstream consumers separate the two paths.
