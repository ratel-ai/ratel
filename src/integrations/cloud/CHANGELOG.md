# Changelog

All notable changes to `@ratel-ai/cloud` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this package adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Initial release: **`RatelClient`** — a best-effort, batched cloud analytics client that ships the *usage rollups* assembled by `@ratel-ai/sdk` to `POST {host}/api/v1/events`, the shape Ratel's dashboard renders. Env-configured (`RATEL_API_KEY`, `RATEL_HOST`), a no-op without an API key, never throws; retries 5xx, drops 4xx, samples by `sampleRate`, auto-flushes by size/interval, and flushes on process exit. Extracted from `@ratel-ai/sdk` per [ADR-0013](../../../docs/adr/0013-observability-and-analytics.md).
- `getClient()` / `configure()` / `setGlobalClient()` process-wide singleton helpers, plus `RatelClientOptions`.
