# Changelog

All notable changes to `@ratel-ai/vercel-ai-sdk` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this package adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0-rc.2] - 2026-07-21

### Changed

- Follow the SDK's model-facing `expose()` → `modelTools()` rename at the call sites (the adapter's `expose` SPI codec is unchanged). Built against `@ratel-ai/sdk@0.5.1-rc.0`.

## [0.1.0-rc.1] - 2026-07-20

### Added

- Initial release: `@ratel-ai/vercel-ai-sdk`, the Vercel AI SDK (`ai@7`) adapter for Ratel. (Supersedes the pre-release `@ratel-ai/ai-sdk-adapter@0.1.0-rc.1`, published under the old name before the rename.) `ratel(config).adaptTo(aiSdk())` speaks the AI SDK's native `Tool` / `ModelMessage` shapes through the framework-adapter SPI (ADR-0013): the `ingest` / `expose` / `recallMessages` codecs plus two per-turn recall idioms — `appendRecall` (mutate-and-suffix-append, cache-preserving) and `prepareStep` (step-0 fresh-array override for `generateText` / `streamText` / `ToolLoopAgent`). Peers `ai@^7.0.0` and `@ratel-ai/sdk` with zero runtime dependencies; passes the `@ratel-ai/sdk/testkit` conformance battery (21 cases). Extracted from the live-verified `bratislava` prototype.
