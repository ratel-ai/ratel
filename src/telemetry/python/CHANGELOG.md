# Changelog

All notable changes to `ratel-ai-telemetry` (the Python telemetry helper) are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this package adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.1] - 2026-07-10

### Added

- `set_content_capture(mode)`: programmatic override of the content-capture gate. While set, `content_capture_mode()` returns the given mode regardless of `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` — code-level config wins over the environment, matching how OpenTelemetry treats env vars as the fallback for programmatic configuration. The mode is validated exactly like the env var (case-insensitive, trimmed, legacy `true`/`false`/`1`/`0` forms accepted) and raises a `ValueError` naming the valid values on anything unrecognized — failing loud at config time instead of storing a value that would both disable capture and mask the env var. Pass `None` to clear unconditionally. Returns a generation token identifying the call as the current owner of the override.
- `clear_content_capture(generation)`: clears the override only when `generation` (the token returned by `set_content_capture`) still identifies the most recent set. A stale token no-ops, so an old telemetry handle shutting down late cannot clobber an override a newer caller installed and silently flip capture back to the env value.

## [0.1.0] - 2026-07-06

### Added

- The telemetry helper (ADR-0015): the full `ratel.*` vocabulary as constants (attribute keys, span/event names, `gen_ai.*` interop keys, and the `Origin`/`SearchTarget`/`AuthOutcome` value enums) pinned to OpenTelemetry semconv `gen_ai` v1.42.0.
- `init()` sugar over the OpenTelemetry Python SDK: wires an OTLP `http/protobuf` exporter to `RATEL_URL` (or `endpoint=`/`headers=`) with a `service.name` resource and batch processor, and returns the provider as a shutdown handle. `content_capture_mode()` reads the `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` gate (default off). OTel deps pinned below 1.42 to keep Python 3.9 support.
- Shared contract-against-the-pin conformance suite (`../conformance/fixtures.json`): spans built from the constants through the real SDK must emit the exact pinned keys.
- Usage example in the README (runnable end-to-end in `examples/telemetry-python`).
- `ratel_span_processor()` / `ratel_span_exporter()` + the default `ratel_signal_filter`: a composable OTLP span-processor for multi-provider coexistence. OpenTelemetry's model is one provider with many span-processors, so a partner already running one (e.g. Langfuse + the Vercel AI SDK) calls `provider.add_span_processor(ratel_span_processor(...))` to dual-export to Ratel — forwarding only the `gen_ai.*` / `ratel.*` signal (overridable via `span_filter`), so the framework's `ai.*` wrapper noise stays out of Ratel. Resolvable top-level via the lazy accessor (a plain `import ratel_ai_telemetry` still pulls no OTel).
- A regression guard that a plain `import ratel_ai_telemetry` pulls no OpenTelemetry SDK.

### Changed

- The OpenTelemetry SDK is an optional `[otlp]` extra: importing `ratel_ai_telemetry` pulls no OTel SDK (ADR-0015), so the SDK (emit), the server (read), and edge/serverless emitters take the `ratel.*` vocabulary weight-free. `init()` lives in the `ratel_ai_telemetry.otlp` submodule (behind the extra) and raises a clear "install `ratel-ai-telemetry[otlp]`" error when it is absent; a lazy top-level accessor keeps `from ratel_ai_telemetry import init` working.
- `init()` refactored onto `ratel_span_processor` (still exports every span — it owns the provider) and now raises, pointing at `ratel_span_processor`, when a `TracerProvider` is already registered globally, instead of silently no-op'ing.
- Released as an independent PyPI unit under the `telemetry-py-v*` tag prefix.
