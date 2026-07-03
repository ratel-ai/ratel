# Changelog

All notable changes to `ratel-ai` (the Python SDK) are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this package adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Usage estimation** bound from `ratel-ai-core`: `estimate_tokens` and `estimate_cost_usd`, plus `ToolCatalog(observe=True)` which records the full-catalog-vs-selected-top-K saving on each search into `last_savings` (in-memory, best-effort, never emitted). No wire format — usage/cost telemetry rides the `ratel-ai-cloud` ADR-0013 event. See [ADR-0015](../../../docs/adr/0015-usage-estimation-in-core.md).

## [0.2.0] - 2026-06-16

### Changed

- **BREAKING:** `search_tools_tool` → `search_capabilities_tool` (`SEARCH_TOOLS_ID` → `SEARCH_CAPABILITIES_ID`). It now returns two independently-ranked buckets — `{ tools, skills }`. Brings the Python SDK to parity with the TypeScript SDK. The old `search_tools_tool`/`SEARCH_TOOLS_ID` are kept as deprecated aliases (see _Deprecated_), so `0.1.x` code keeps working after upgrading.

### Added

- First-class **skills**: `SkillCatalog`, `Skill`, `get_skill_content_tool` (`get_skill_content`), and the native `SkillRegistry`/`SkillHit` — the on-demand skill analogue of the tool catalog, ranked by a separate BM25 corpus.
- Skill–tool coupling: a `Skill` can declare a `tools` list, and `search_capabilities` pulls a matched skill's declared tools into the `tools` bucket — additively (beyond `topKTools`) and deduped against query hits — so the agent gets the playbook and the tools it needs in one turn.

### Deprecated

- `search_tools_tool` and `SEARCH_TOOLS_ID`. They retain their pre-0.2.0 behaviour — a tools-only `{groups}` result and the `search_tools` id — so upgrading from `0.1.x` does not break existing callers. Migrate to `search_capabilities_tool`; the aliases will be removed in a future release.

### Fixed

- Gateway error payloads carry `isError: True`; `invoke_tool` rejects a non-object `args` instead of forwarding stray top-level keys.
- `search_capabilities_tool` validates `topKTools`/`topKSkills` (declared `integer`, positive): `0`, negative, `bool`, and `float` fall back to the default, matching the TypeScript SDK exactly.
- `search_capabilities_tool` advertises the `skills` bucket and `get_skill_content` in its description only when a non-empty `SkillCatalog` is provided.

## [0.1.6] - 2026-06-10

### Added

- Initial release of the Python SDK. Binds the Rust core (`ratel-ai-core`) via PyO3, distributed as prebuilt `abi3` wheels for darwin-arm64, darwin-x64, linux-x64-gnu, linux-arm64-gnu, and win32-x64-msvc — no Rust toolchain required to install. (`v0.1.5` shipped TS-only on 2026-05-10; the first release carrying Python is the next version bump.) Binding strategy locked in [ADR-0011](../../../docs/adr/0011-python-rust-binding-strategy.md).
- Full feature parity with the TypeScript SDK (`@ratel-ai/sdk`):
  - `ToolRegistry` / `SearchHit` — metadata-only BM25 index (native).
  - `ToolCatalog` accepts a `trace` config (`noop` default, `memory`, or `jsonl`); captured events flow through the Rust core sink ([ADR-0009](../../../docs/adr/0009-trace-events-core-owned-schema.md)). Exposes `record_event`, `drain_trace_events`, and an `origin` argument on `search`. `invoke` emits `invoke_start` / `invoke_end` / `invoke_error` with `args_size_bytes` and `took_ms`, and awaits coroutine executors.
  - `search_tools_tool` / `invoke_tool_tool` gateway factories with verbatim descriptions and JSON schemas from the TS SDK. `search_tools_tool` emits `gateway_search` with `origin: "agent"`; `invoke_tool_tool` emits `gateway_invoke` / `gateway_error` and handles the `needs_auth` / `on_unauthorized` path.
  - `register_mcp_server` ingests an upstream MCP `ClientSession` (optional `mcp` extra, `pip install 'ratel-ai[mcp]'`), namespacing tool ids as `<server>__<tool>` and emitting `upstream_register` / `upstream_invoke` / `upstream_error`.
- Ships type stubs (`_native.pyi`, `py.typed`) for a fully typed install.
