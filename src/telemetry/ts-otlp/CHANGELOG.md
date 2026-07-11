# Changelog

All notable changes to `@ratel-ai/telemetry-otlp` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this package adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- On first setup, `TelemetryInitOptions.enabled: false` returns a no-op shutdown handle without endpoint or provider setup; once Ratel owns the provider, repeated calls return its original handle. `RatelSpanProcessorOptions.enabled: false` always returns a no-op processor.
- `TelemetryInitOptions.spanFilter` lets the turnkey provider select spans without hand-building a `NodeTracerProvider`; omitting it preserves the export-everything default.
- `init()` is idempotent to the provider it installed: repeated and module-reloaded calls return the exact original handle, while a foreign global provider still raises the composition error. If another `init()` wins the registration race, the loser now returns that Ratel-owned handle instead of raising.
- Re-exports `API_KEY_ENV` from `@ratel-ai/telemetry` alongside `ENDPOINT_ENV`.

### Changed

- `@opentelemetry/api` is now a peer + development dependency so the host and Ratel share one global API instance. The exporter, resources, semantic conventions, and trace SDK packages remain runtime dependencies, preserving the one-package turnkey install (npm/pnpm auto-install the peer; yarn needs an explicit `add @opentelemetry/api`).
- `init()` shutdown is terminal: after `handle.shutdown()`, a later `init()` throws an already-shut-down error instead of silently returning the dead handle (call `trace.disable()` first to re-initialize). A shared handle's `shutdown()` stops export for all callers.

## [0.1.0] - 2026-07-06

### Added

- Initial release: the `init()` OTLP exporter, split out of `@ratel-ai/telemetry` so the `ratel.*` vocabulary stays OTel-free (ADR-0015). `init()` wires an OTLP `http/protobuf` exporter to `RATEL_URL` (or `{ endpoint, headers }`) over a `NodeTracerProvider`, registers it as the global provider, and returns a shutdown handle. Depends on `@ratel-ai/telemetry` for the vocabulary and the pure OTLP config resolution; re-exports `resolveOtlpConfig`, `InitOptions`, and `ResolvedOtlpConfig` for convenience.
- `ratelSpanProcessor()` / `ratelTraceExporter()` + the default `ratelSignalFilter`: a composable OTLP span-processor for multi-provider coexistence. OpenTelemetry's model is one provider with many span-processors, so a partner already running one (e.g. Langfuse + the Vercel AI SDK) adds `ratelSpanProcessor` to their provider's `spanProcessors` to dual-export to Ratel — forwarding only the `gen_ai.*` / `ratel.*` signal (overridable via `spanFilter`; `() => true` sends everything), so the framework's `ai.*` wrapper noise stays out of Ratel.

### Changed

- `init()` refactored onto `ratelSpanProcessor` (still exports every span — it owns the provider) and now throws, pointing at `ratelSpanProcessor`, when a `TracerProvider` is already registered globally, instead of silently no-op'ing.
