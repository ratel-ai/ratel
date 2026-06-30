# Changelog

All notable changes to `ratel-ai-cloud` (the Python cloud client) are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this package adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Initial release. Pure-Python client for Ratel Cloud telemetry — no native addon, runs on any runtime.
  Event schema mirrors the canonical `ratel-ai-cloud` Rust crate, kept honest by shared conformance
  fixtures ([ADR-0013](../../../docs/adr/0013-cloud-telemetry-unified-schema.md)).
  - `Event` and related `TypedDict`s — the unified v1 telemetry shape.
  - `validate` — semantic validation returning a `ValidationResult` of `{path, message}` issues.
  - `send_batch` — best-effort `httpx` batch POST with exponential backoff + jitter; never raises.
  - `RatelCloud` — non-blocking `record` / `flush` / `aclose`, batching, and an async-context periodic
    flush.
