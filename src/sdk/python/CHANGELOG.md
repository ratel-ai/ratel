# Changelog

All notable changes to `ratel-ai` (the Python SDK) are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this package adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.5] - 2026-06-08

### Added

- Initial release of the Python SDK. Binds the Rust core (`ratel-ai-core`) via PyO3, distributed as prebuilt `abi3` wheels for darwin-arm64, darwin-x64, linux-x64-gnu, linux-arm64-gnu, and win32-x64-msvc — no Rust toolchain required to install. Binding strategy locked in [ADR-0011](../../../docs/adr/0011-python-rust-binding-strategy.md).
- Full feature parity with the TypeScript SDK (`@ratel-ai/sdk`):
  - `ToolRegistry` / `SearchHit` — metadata-only BM25 index (native).
  - `ToolCatalog` accepts a `trace` config (`noop` default, `memory`, or `jsonl`); captured events flow through the Rust core sink ([ADR-0009](../../../docs/adr/0009-trace-events-core-owned-schema.md)). Exposes `record_event`, `drain_trace_events`, and an `origin` argument on `search`. `invoke` emits `invoke_start` / `invoke_end` / `invoke_error` with `args_size_bytes` and `took_ms`, and awaits coroutine executors.
  - `search_tools_tool` / `invoke_tool_tool` gateway factories with verbatim descriptions and JSON schemas from the TS SDK. `search_tools_tool` emits `gateway_search` with `origin: "agent"`; `invoke_tool_tool` emits `gateway_invoke` / `gateway_error` and handles the `needs_auth` / `on_unauthorized` path.
  - `register_mcp_server` ingests an upstream MCP `ClientSession` (optional `mcp` extra, `pip install 'ratel-ai[mcp]'`), namespacing tool ids as `<server>__<tool>` and emitting `upstream_register` / `upstream_invoke` / `upstream_error`.
- Ships type stubs (`_native.pyi`, `py.typed`) for a fully typed install.
