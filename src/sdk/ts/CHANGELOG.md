# Changelog

All notable changes to `@ratel-ai/sdk` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this package adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.1-rc.1] - 2026-07-04

### Changed

- First release cut under the per-package release scheme (ADR-0016): `@ratel-ai/sdk` (loader + platform packages) now versions and ships independently, tagged `sdk-js-v*`. No API changes since 0.2.0.

## [0.2.0] - 2026-06-16

### Changed

- **BREAKING:** the discovery gateway tool is renamed `search_tools` → `search_capabilities`. It now returns two independently-ranked, separately-budgeted buckets — `{ tools, skills }` — so a relevant skill is never crowded out by matching tools. New surface: `searchCapabilitiesTool`/`SEARCH_CAPABILITIES_ID`. The old `searchToolsTool`/`SEARCH_TOOLS_ID` are kept as deprecated aliases (see _Deprecated_), so `0.1.x` code keeps working after upgrading.

### Added

- First-class **skills**: `SkillCatalog`, `getSkillContentTool` (`get_skill_content`), and `Skill`/`SkillHit`/`SkillRegistry`. Skills are reusable playbooks ranked by a separate BM25 corpus and loaded on demand.
- Skill–tool coupling: a `Skill` can declare a `tools` list, and `search_capabilities` pulls a matched skill's declared tools into the `tools` bucket — additively (beyond `topKTools`) and deduped against query hits — so the agent gets the playbook and the tools it needs in one turn.

### Deprecated

- `searchToolsTool`, `SEARCH_TOOLS_ID`, and the `SearchToolHit`/`SearchToolsGroup`/`SearchToolsResult`/`SearchToolsToolOptions` types. They retain their pre-0.2.0 behaviour — a tools-only `{ groups }` result and the `search_tools` id — so upgrading from `0.1.x` does not break existing callers. Migrate to `searchCapabilitiesTool`; the aliases will be removed in a future release.

### Fixed

- Gateway error payloads (`invoke_tool`, `get_skill_content`) carry `isError: true`, so a host can flag a failed call rather than read it as content.
- `invoke_tool` rejects a non-object `args` instead of forwarding stray top-level keys.
- `search_capabilities` validates `topKTools`/`topKSkills` (declared `integer`, positive): `0`, negative, and fractional values fall back to the default instead of returning zero results — or, via a negative wrapping to `u32` in the native layer, an unbounded set. TypeScript and Python behave identically.
- `search_capabilities` advertises the `skills` bucket and `get_skill_content` in its description only when a non-empty skill catalog is wired in.
- `Skill.tags` and `Skill.body` are optional (default `[]`/`""`), matching the Python SDK — a minimal `{ id, name, description }` skill is valid.

## [0.1.6] - 2026-06-10

### Fixed

- TypeScript typehint for JSON-schema tool input/output ([#54](https://github.com/ratel-ai/ratel/pull/54)).

## [0.1.5] - 2026-05-10

### Added

- Initial release on the v1 (revamp) line. TypeScript SDK over the Rust core: BM25 tool retrieval, MCP ingestion, framework-neutral gateway tools. See the [package README](README.md) for the full surface.
- `ToolCatalog` accepts `{ trace }` config in its constructor — `noop` (default), `memory`, or `jsonl`. Captured events flow through the Rust core sink ([ADR-0009](../../../docs/adr/0009-trace-events-core-owned-schema.md)). New `recordEvent`, `drainTraceEvents`, and an optional third `origin` argument on `search`.
- `searchToolsTool` emits `gateway_search` with `origin: "agent"`. `invokeToolTool` emits `gateway_invoke` on success and `gateway_error` for unknown ids, `needs_auth`, and underlying throws.
- `ToolCatalog.invoke` emits `invoke_start` / `invoke_end` / `invoke_error` around the executor with `args_size_bytes` and `took_ms`.
- `registerMcpServer` emits `upstream_register` on connect and `upstream_invoke` / `upstream_error` per upstream call. New `searchWithOrigin` and trace plumbing on the underlying NAPI `ToolRegistry`. `SearchOrigin` is now `"direct" | "agent"` (was `"user" | "agent"`); the union is exported from the package entry point.

### Changed

- Rewrote `search_tools` description to nudge agents toward discovery before falling back to broad listing.
