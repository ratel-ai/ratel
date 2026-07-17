# Changelog

All notable changes to `@ratel-ai/ai-sdk-adapter` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this package adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Initial release: `@ratel-ai/ai-sdk-adapter`, the Vercel AI SDK (`ai@7`) adapter for Ratel. `ratel(config).adaptTo(aiSdk())` speaks the AI SDK's native `Tool` / `ModelMessage` shapes through the framework-adapter SPI (ADR-0013): the `ingest` / `expose` / `recallMessages` codecs plus two per-turn recall idioms — `appendRecall` (mutate-and-suffix-append, cache-preserving) and `prepareStep` (step-0 fresh-array override for `generateText` / `streamText` / `ToolLoopAgent`). Peers `ai@^7.0.0` and `@ratel-ai/sdk` with zero runtime dependencies; passes the `@ratel-ai/sdk/testkit` conformance battery (21 cases). Extracted from the live-verified `bratislava` prototype.
