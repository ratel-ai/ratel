# Changelog

All notable changes to `ratel-ai-cloud` (the cloud telemetry schema crate) are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this crate adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Initial release. The canonical schema for Ratel Cloud telemetry — agent (LLM call) events
  ([ADR-0013](../../../docs/adr/0013-cloud-telemetry-unified-schema.md)).
  - `Event` and supporting types (`Message`, `Content`, `Block`, `ToolDef`, `Params`, `Usage`,
    `FinishReason`) with serde (de)serialization. Strict but forward-compatible: closed type surface,
    unknown fields ignored on read.
  - `validate` — semantic invariants returning a `ValidationError` of `{path, message}` issues.
  - `dump_fixtures` example — regenerates the shared `../fixtures/valid` conformance vectors from the
    canonical types, the cross-language contract the pure-language clients replay.
