# Changelog

All notable changes to `ratel-ai-telemetry` (the Rust telemetry constants crate) are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this package adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0-rc.2] - 2026-07-05

### Changed

- Released as an independent crates.io unit under the `telemetry-core-v*` tag prefix.

## [0.1.0-rc.1] - 2026-07-05

### Added

- The telemetry vocabulary (ADR-0015): the full `ratel.*` constants (attribute keys, span/event names, `gen_ai.*` interop keys, and the `Origin`/`SearchTarget`/`AuthOutcome` value enums) pinned to OpenTelemetry semconv `gen_ai` v1.42.0, as zero-dependency `&str` constants and enums.
- The `contract-against-the-pin` test suite: every constant is asserted against its pinned wire key, so the vocabulary cannot drift from `CONVENTIONS.md`.

This crate is constants-only. The Rust `init()` OTLP builder lands with its first consumer, the server (per ADR-0015); the TS and Python helpers ship `init()` now.
