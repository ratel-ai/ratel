# Changelog

All notable changes to `@ratel-ai/telemetry-otlp` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this package adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-07-06

### Added

- Initial release: the `init()` OTLP exporter, split out of `@ratel-ai/telemetry` so the `ratel.*` vocabulary stays OTel-free (ADR-0015). `init()` wires an OTLP `http/protobuf` exporter to `RATEL_URL` (or `{ endpoint, headers }`) over a `NodeTracerProvider`, registers it as the global provider, and returns a shutdown handle. Depends on `@ratel-ai/telemetry` for the vocabulary and the pure OTLP config resolution; re-exports `resolveOtlpConfig`, `InitOptions`, and `ResolvedOtlpConfig` for convenience.
- `ratelSpanProcessor()` / `ratelTraceExporter()` + the default `ratelSignalFilter`: a composable OTLP span-processor for multi-provider coexistence. OpenTelemetry's model is one provider with many span-processors, so a partner already running one (e.g. Langfuse + the Vercel AI SDK) adds `ratelSpanProcessor` to their provider's `spanProcessors` to dual-export to Ratel — forwarding only the `gen_ai.*` / `ratel.*` signal (overridable via `spanFilter`; `() => true` sends everything), so the framework's `ai.*` wrapper noise stays out of Ratel.

### Changed

- `init()` refactored onto `ratelSpanProcessor` (still exports every span — it owns the provider) and now throws, pointing at `ratelSpanProcessor`, when a `TracerProvider` is already registered globally, instead of silently no-op'ing.
