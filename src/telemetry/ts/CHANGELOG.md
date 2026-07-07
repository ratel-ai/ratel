# Changelog

All notable changes to `@ratel-ai/telemetry` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this package adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-07-06

### Added

- The telemetry helper (ADR-0015): the full `ratel.*` vocabulary as constants (attribute keys, span/event names, `gen_ai.*` interop keys, and the `Origin`/`SearchTarget`/`AuthOutcome` value enums) pinned to OpenTelemetry semconv `gen_ai` v1.42.0.
- Shared contract-against-the-pin conformance suite (`../conformance/fixtures.json`): spans built from the constants through the real SDK must emit the exact pinned keys.
- Usage example in the README (runnable end-to-end in `examples/telemetry-ts`).
- A regression guard that no `@opentelemetry/*` runtime dependency or shipped-source import can creep back into the vocabulary package.

### Changed

- `init()` lives in [`@ratel-ai/telemetry-otlp`](../ts-otlp/README.md), not this package: importing `@ratel-ai/telemetry` pulls no OpenTelemetry SDK (ADR-0015), so the SDK (emit), the server (read), and edge/serverless emitters take the `ratel.*` vocabulary weight-free. This package keeps the constants plus the pure `resolveOtlpConfig` / `contentCaptureMode`; callers of `init()` install `@ratel-ai/telemetry-otlp` and import it from there.
- Released as an independent npm unit under the `telemetry-ts-v*` tag prefix.
