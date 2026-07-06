# Changelog

All notable changes to `@ratel-ai/telemetry` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this package adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0-rc.3] - 2026-07-05

### Changed

- **Breaking (pre-GA):** `init()` moved out of this package into the new [`@ratel-ai/telemetry-otlp`](../ts-otlp/README.md). Importing `@ratel-ai/telemetry` now pulls no OpenTelemetry SDK (ADR-0015), so the SDK (emit), the server (read), and edge/serverless emitters take the `ratel.*` vocabulary weight-free. This package keeps the constants plus the pure `resolveOtlpConfig` / `contentCaptureMode`; callers of `init()` install `@ratel-ai/telemetry-otlp` and import it from there.

### Added

- A regression guard that no `@opentelemetry/*` runtime dependency or shipped-source import can creep back into the vocabulary package.

## [0.1.0-rc.2] - 2026-07-05

### Added

- Usage example in the README (runnable end-to-end in `examples/telemetry-ts`).

### Changed

- Released as an independent npm unit under the `telemetry-js-v*` tag prefix.

## [0.1.0-rc.1] - 2026-07-05

### Added

- The telemetry helper (ADR-0015): the full `ratel.*` vocabulary as constants (attribute keys, span/event names, `gen_ai.*` interop keys, and the `Origin`/`SearchTarget`/`AuthOutcome` value enums) pinned to OpenTelemetry semconv `gen_ai` v1.42.0.
- `init()` sugar over the OpenTelemetry JS SDK: wires an OTLP `http/protobuf` exporter to `RATEL_URL` (or `{ endpoint, headers }`) with a `service.name` resource and batch processor, and returns a shutdown handle. `contentCaptureMode()` reads the `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` gate (default off).
- Shared contract-against-the-pin conformance suite (`../conformance/fixtures.json`): spans built from the constants through the real SDK must emit the exact pinned keys.
