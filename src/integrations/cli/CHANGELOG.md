# Changelog

All notable changes to `@ratel-ai/cli` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this package adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.0-rc.2] - 2026-06-30

_No package-specific changes; released in lockstep with the workspace (hybrid retrieval lands in `ratel-ai-core` and the SDKs)._

## [0.2.0] - 2026-06-16

### Changed

- Version bump to stay in lockstep with the coordinated `0.2.0` SDK release (first-class skills). No CLI behaviour change.

## [0.1.6] - 2026-06-10

### Changed

- Version bump for the coordinated v0.1.6 release. No user-facing CLI changes since 0.1.5; the internal `@ratel-ai/mcp-server` dependency is now consumed from npm (extracted to `ratel-ai/ratel-mcp`). Re-published in lockstep to keep all artifacts version-aligned.

## [0.1.5] - 2026-05-10

### Added

- Initial release on the v1 (revamp) line. Manage MCP servers across scopes, run the Ratel MCP gateway, import Claude Code's MCP setup, drive OAuth flows. See the [package README](README.md) for the full surface.
- `ratel mcp auth --check`: read-only status report per upstream (tokens present, refresh available, time-to-expiry / "expired N ago"). No network calls.
- `ratel serve` writes telemetry to `~/.ratel/telemetry/<project-slug>/<ISO-ts>-<short>.jsonl` by default (one JSON line per event, mode `0600` on Unix). Opt out with `--telemetry off` (or `RATEL_TELEMETRY=off`); override the path with `--telemetry-file <path>`; override the directory with `RATEL_TELEMETRY_DIR`. The slug mirrors Claude Code's `~/.claude/projects/` convention (every `/` and `.` in the absolute path becomes `-`).
- New `ratel inspect` verb — summarizes the most recent telemetry session into ASCII tables (session totals, top tools by hit count, gateway-vs-direct invoke split, top errors). Flags: `--from <FILE>`, `--last <N>`, `--project <ABS-PATH>` (target another project's bucket), `--all` (scan every bucket). `ratel inspect ls` lists files newest-first.

### Changed

- **BREAKING**: `ratel mcp serve` is now `ratel serve`. The `mcp` group manages configuration; serving the gateway is its own top-level command (room for future `--as-<protocol>` modes). After upgrading, re-run `ratel mcp import` (or `ratel mcp link`) so Claude Code's config points at `["serve", ...]` instead of `["mcp", "serve", ...]`.
- `ratel mcp auth` is now refresh-first — when a `refresh_token` is on disk, rotates silently with no browser. Output annotates each row as `authorized (refreshed)` vs `authorized (re-authed)` so you know which path ran.
