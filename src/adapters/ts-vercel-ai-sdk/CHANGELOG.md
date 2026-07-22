# Changelog

All notable changes to `@ratel-ai/vercel-ai-sdk` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this package adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0-rc.3] - 2026-07-22

### Added

- AI SDK v5 and v6 support: the `ai` peer range widens from `^7.0.0` to `^5.0.0 || ^6.0.0 || ^7.0.0` (`ai@4` stays excluded — it predates the v5 tool/message reshape). One shared code path absorbs the per-major differences: provider-defined tools pass through under both discriminators (`provider-defined` in `ai@5`, `provider` in `ai@6`/`ai@7`), catalog executors receive both context spellings (`experimental_context` and `context`), and a Promise-like JSON Schema is rejected synchronously before the registration batch commits.
- Exact-version compatibility matrix in CI: `ai@5.0.0`, `5.0.217`, `6.0.0`, `6.0.232`, `7.0.0`, and `7.0.33` each build, typecheck, test, pack, and typecheck a packed-tarball consumer. Narrowing the supported-majors peer range is a breaking change of the adapter (see the README's Compatibility section).

### Fixed

- `prepareStep` now preserves the injected recall pair across the steps of one `generateText` / `streamText` / `ToolLoopAgent` run on `ai@5`/`ai@6`, which rebuild the prompt per step (the pair is reinserted at its original boundary from per-run state); on `ai@7`, which carries the step-0 override forward itself, the duplicate check makes reinsertion a no-op.

## [0.1.0-rc.2] - 2026-07-21

### Changed

- Follow the SDK's model-facing `expose()` → `modelTools()` rename at the call sites (the adapter's `expose` SPI codec is unchanged). Built against `@ratel-ai/sdk@0.5.1-rc.0`.

## [0.1.0-rc.1] - 2026-07-20

### Added

- Initial release: `@ratel-ai/vercel-ai-sdk`, the Vercel AI SDK (`ai@7`) adapter for Ratel. (Supersedes the pre-release `@ratel-ai/ai-sdk-adapter@0.1.0-rc.1`, published under the old name before the rename.) `ratel(config).adaptTo(aiSdk())` speaks the AI SDK's native `Tool` / `ModelMessage` shapes through the framework-adapter SPI (ADR-0013): the `ingest` / `expose` / `recallMessages` codecs plus two per-turn recall idioms — `appendRecall` (mutate-and-suffix-append, cache-preserving) and `prepareStep` (step-0 fresh-array override for `generateText` / `streamText` / `ToolLoopAgent`). Peers `ai@^7.0.0` and `@ratel-ai/sdk` with zero runtime dependencies; passes the `@ratel-ai/sdk/testkit` conformance battery (21 cases). Extracted from the live-verified `bratislava` prototype.
