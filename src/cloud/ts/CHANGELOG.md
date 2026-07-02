# Changelog

All notable changes to `@ratel-ai/cloud` (the TypeScript cloud client) are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this package adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Initial release. Pure-TypeScript client for Ratel Cloud telemetry — no native addon, runs on edge
  runtimes. Event schema mirrors the canonical `ratel-ai-cloud` Rust crate, kept honest by shared
  conformance fixtures ([ADR-0013](../../../docs/adr/0013-cloud-telemetry-unified-schema.md)).
  - Canonical `Event` types — the unified v1 telemetry shape.
  - `validate` — semantic validation returning `{ ok }` or `{ ok: false, issues }`.
  - `sendEventBatch` — best-effort `fetch` batch POST with exponential backoff + jitter; never throws.
  - `RatelCloud` — non-blocking `sendEvent` / `flush` / `close`, batching, and a periodic auto-flush timer.
