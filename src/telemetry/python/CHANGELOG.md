# Changelog

All notable changes to `ratel-ai-telemetry` (the Python telemetry helper) are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this package adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0-rc.4] - 2026-07-05

### Added

- `ratel_span_processor()` / `ratel_span_exporter()` + the default `ratel_signal_filter`: a composable OTLP span-processor for multi-provider coexistence. OpenTelemetry's model is one provider with many span-processors, so a partner already running one (e.g. Langfuse + the Vercel AI SDK) calls `provider.add_span_processor(ratel_span_processor(...))` to dual-export to Ratel — forwarding only the `gen_ai.*` / `ratel.*` signal (overridable via `span_filter`), so the framework's `ai.*` wrapper noise stays out of Ratel. Resolvable top-level via the lazy accessor (a plain `import ratel_ai_telemetry` still pulls no OTel).

### Changed

- `init()` refactored onto `ratel_span_processor` (still exports every span — it owns the provider) and now raises, pointing at `ratel_span_processor`, when a `TracerProvider` is already registered globally, instead of silently no-op'ing.

## [0.1.0-rc.3] - 2026-07-05

### Changed

- The OpenTelemetry SDK is now an optional `[otlp]` extra: importing `ratel_ai_telemetry` pulls no OTel SDK (ADR-0015), so the SDK (emit), the server (read), and edge/serverless emitters take the `ratel.*` vocabulary weight-free. `init()` lives in the `ratel_ai_telemetry.otlp` submodule (behind the extra) and raises a clear "install `ratel-ai-telemetry[otlp]`" error when it is absent; a lazy top-level accessor keeps `from ratel_ai_telemetry import init` working.

### Added

- A regression guard that a plain `import ratel_ai_telemetry` pulls no OpenTelemetry SDK.

## [0.1.0-rc.2] - 2026-07-05

### Added

- Usage example in the README (runnable end-to-end in `examples/telemetry-python`).

### Changed

- Released as an independent PyPI unit under the `telemetry-py-v*` tag prefix.

## [0.1.0-rc.1] - 2026-07-05

### Added

- The telemetry helper (ADR-0015): the full `ratel.*` vocabulary as constants (attribute keys, span/event names, `gen_ai.*` interop keys, and the `Origin`/`SearchTarget`/`AuthOutcome` value enums) pinned to OpenTelemetry semconv `gen_ai` v1.42.0.
- `init()` sugar over the OpenTelemetry Python SDK: wires an OTLP `http/protobuf` exporter to `RATEL_URL` (or `endpoint=`/`headers=`) with a `service.name` resource and batch processor, and returns the provider as a shutdown handle. `content_capture_mode()` reads the `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` gate (default off). OTel deps pinned below 1.42 to keep Python 3.9 support.
- Shared contract-against-the-pin conformance suite (`../conformance/fixtures.json`): spans built from the constants through the real SDK must emit the exact pinned keys.
