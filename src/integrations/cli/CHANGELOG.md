# Changelog

All notable changes to `@ratel-ai/cli` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this package adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- **BREAKING**: `ratel mcp serve` is now `ratel serve`. The `mcp` group manages configuration; serving the gateway is its own top-level command (room for future `--as-<protocol>` modes). After upgrading, re-run `ratel mcp import` (or `ratel mcp link`) so Claude Code's config points at `["serve", ...]` instead of `["mcp", "serve", ...]`.

### Added

- `ratel serve` writes telemetry to `~/.ratel/telemetry/<project-slug>/<ISO-ts>-<short>.jsonl` by default (one JSON line per event, mode `0600` on Unix). Opt out with `--telemetry off` (or `RATEL_TELEMETRY=off`); override the path with `--telemetry-file <path>`; override the directory with `RATEL_TELEMETRY_DIR`.
- New `ratel inspect` verb — summarizes the most recent telemetry session into ASCII tables (session totals, top tools by hit count, gateway-vs-direct invoke split, top errors). Flags: `--from <FILE>`, `--last <N>`. `ratel inspect ls` lists files newest-first.

## [0.1.5-rc.3] - 2026-05-08

### Added

- `ratel mcp auth --check`: read-only status report per upstream (tokens present, refresh available, time-to-expiry / "expired N ago"). No network calls.

### Changed

- `ratel mcp auth` is now refresh-first — when a `refresh_token` is on disk, rotates silently with no browser. Output annotates each row as `authorized (refreshed)` vs `authorized (re-authed)` so you know which path ran.

## [0.1.5-rc.2] - 2026-05-07

_No package-specific changes; released in lockstep with the workspace._

## [0.1.5-rc.1] - 2026-05-07

### Added

- Initial release on the v1 (revamp) line. Manage MCP servers across scopes, run the Ratel MCP gateway, import Claude Code's MCP setup, drive OAuth flows. See the [package README](README.md) for the full surface.
