# Changelog

All notable changes to `ratel-ai-telemetry` (the Python telemetry helper) are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this package adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0-rc.1] - 2026-07-05

### Added

- The telemetry helper (ADR-0015): the full `ratel.*` vocabulary as constants (attribute keys, span/event names, `gen_ai.*` interop keys, and the `Origin`/`SearchTarget`/`AuthOutcome` value enums) pinned to OpenTelemetry semconv `gen_ai` v1.42.0.
- `init()` sugar over the OpenTelemetry Python SDK: wires an OTLP `http/protobuf` exporter to `RATEL_URL` (or `endpoint=`/`headers=`) with a `service.name` resource and batch processor, and returns the provider as a shutdown handle. `content_capture_mode()` reads the `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` gate (default off). OTel deps pinned below 1.42 to keep Python 3.9 support.
- Shared contract-against-the-pin conformance suite (`../conformance/fixtures.json`): spans built from the constants through the real SDK must emit the exact pinned keys.
