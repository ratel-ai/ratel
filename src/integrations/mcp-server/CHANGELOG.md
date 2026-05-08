# Changelog

All notable changes to `@ratel-ai/mcp-server` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this package adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.5-rc.3] - 2026-05-08

### Added

- Proactive OAuth refresh at gateway boot. Each HTTP/SSE upstream with stored tokens has its access token refreshed up front when expired or near expiry, so the catalog comes online with fresh credentials.
- Cross-process file lock on the OAuth token store (via `proper-lockfile`). Multiple Ratel gateways on the same host (overlapping `serve`s, CLI flows) cannot race on the same `refresh_token` — only one process performs the network refresh; the rest read the rotated tokens from disk under the same lock. Also closes the read-modify-write race in `RatelOAuthStore.save()`.

### Changed

- `runAuthFlow` is now refresh-first: it attempts a silent refresh before spinning up the loopback callback server, and only falls back to PKCE when refresh is impossible or fails. Each `AuthFlowResult` carries a new `mode: "refresh" | "interactive"` field.

### Fixed

- Boot-time OAuth provider now sets `redirectUrl`, so the SDK takes the refresh-token branch instead of throwing `prepareTokenRequest is required`. Auth-shaped boot errors are now classified as `needsAuth: true` (upstream retained, awaits an interactive flow) rather than silently dropping the upstream.

## [0.1.5-rc.2] - 2026-05-07

_No package-specific changes; released in lockstep with the workspace._

## [0.1.5-rc.1] - 2026-05-07

### Added

- Initial release on the v1 (revamp) line. MCP server library that exposes a Ratel tool catalog as a Model Context Protocol server. See the [package README](README.md) for the full surface.
