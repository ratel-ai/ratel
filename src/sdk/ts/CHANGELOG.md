# Changelog

All notable changes to `@ratel-ai/sdk` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this package adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.5] - 2026-05-10

### Added

- Initial release on the v1 (revamp) line. TypeScript SDK over the Rust core: BM25 tool retrieval, MCP ingestion, framework-neutral gateway tools. See the [package README](README.md) for the full surface.
- `ToolCatalog` accepts `{ trace }` config in its constructor — `noop` (default), `memory`, or `jsonl`. Captured events flow through the Rust core sink ([ADR-0009](../../../docs/adr/0009-trace-events-core-owned-schema.md)). New `recordEvent`, `drainTraceEvents`, and an optional third `origin` argument on `search`.
- `searchToolsTool` emits `gateway_search` with `origin: "agent"`. `invokeToolTool` emits `gateway_invoke` on success and `gateway_error` for unknown ids, `needs_auth`, and underlying throws.
- `ToolCatalog.invoke` emits `invoke_start` / `invoke_end` / `invoke_error` around the executor with `args_size_bytes` and `took_ms`.
- `registerMcpServer` emits `upstream_register` on connect and `upstream_invoke` / `upstream_error` per upstream call. New `searchWithOrigin` and trace plumbing on the underlying NAPI `ToolRegistry`. `SearchOrigin` is now `"direct" | "agent"` (was `"user" | "agent"`); the union is exported from the package entry point.

### Changed

- Rewrote `search_tools` description to nudge agents toward discovery before falling back to broad listing.
