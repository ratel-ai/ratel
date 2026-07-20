# Changelog

All notable changes to `@ratel-ai/mastra` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this package adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0-rc.2] - 2026-07-21

### Changed

- Follow the SDK's model-facing `expose()` → `modelTools()` rename at the call sites (the adapter's `expose` SPI codec is unchanged). Rebased onto the current adapter SPI and built against `@ratel-ai/sdk@0.5.1-rc.0`.

## [0.1.0-rc.1] - 2026-07-18

### Added

- Initial release: `@ratel-ai/mastra`, the [Mastra](https://mastra.ai) (`@mastra/core`) adapter for Ratel. (Supersedes the pre-release `@ratel-ai/mastra-adapter@0.1.0-rc.1`, published under the old name before the rename.) `ratel(config).adaptTo(mastra())` speaks Mastra's native `Tool` (from `createTool`) and `MastraDBMessage` shapes through the framework-adapter SPI (ADR-0013): the `ingest` / `expose` / `recallMessages` codecs plus a per-turn recall idiom — `recallProcessor()`, a Mastra `Processor` you drop into an Agent's `inputProcessors`. `ingest` reads Mastra's normalized input schema (so zod 3, zod 4, and raw JSON Schema tools all work); `expose` wraps the three capability tools as genuine `createTool` results; `recallMessages` encodes the synthetic `search_capabilities` call+result as one assistant message (`content.format: 2`, a single resolved `tool-invocation` part). Peers `@mastra/core@^1.51.0`, `zod@^3.25.0 || ^4.0.0`, and `@ratel-ai/sdk` with zero runtime dependencies; passes the `@ratel-ai/sdk/testkit` conformance battery (21 cases).
