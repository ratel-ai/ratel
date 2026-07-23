# Changelog

All notable changes to `@ratel-ai/mastra` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this package adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-07-24

### Added

- Initial release: `@ratel-ai/mastra`, the [Mastra](https://mastra.ai) (`@mastra/core`) adapter for Ratel. `ratel(config).adaptTo(mastra())` speaks Mastra's native `Tool` (from `createTool`) and `MastraDBMessage` shapes through the framework-adapter SPI (ADR-0013): the `ingest` / `expose` / `recallMessages` codecs plus a per-turn recall idiom — `recallProcessor()`, a Mastra `Processor` you drop into an Agent's `inputProcessors`. `ingest` reads Mastra's normalized input schema (so zod 3, zod 4, and raw JSON Schema tools all work); `expose` wraps the three capability tools as genuine `createTool` results; `recallMessages` encodes the synthetic `search_capabilities` call+result as one assistant message (`content.format: 2`, a single resolved `tool-invocation` part). Tool execution preserves Mastra's complete live `ToolExecutionContext` through `invoke_tool` — `requestContext`, workspace, agent thread/resource metadata, `mastra`, and `abortSignal` — so `requestContextSchema` values validate against the caller's real context and concurrent invocations stay isolated (direct `ToolCatalog.invoke` calls use the documented context-free fallback). Peers `@mastra/core@>=1.11.0 <2` (the adapter owns its no-op observer and validation-error guard locally, and is CI-tested against 1.11.0, 1.31.0, and 1.51.0), `zod@^3.25.0 || ^4.0.0`, and `@ratel-ai/sdk` (Node.js ≥ 22.13.0) with zero runtime dependencies; passes the `@ratel-ai/sdk/testkit` conformance battery.
