# Changelog

All notable changes to `@ratel-ai/telemetry-otlp` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this package adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0-rc.3] - 2026-07-05

### Added

- Initial release: the `init()` OTLP exporter, split out of `@ratel-ai/telemetry` so the `ratel.*` vocabulary stays OTel-free (ADR-0015). `init()` wires an OTLP `http/protobuf` exporter to `RATEL_URL` (or `{ endpoint, headers }`) over a `NodeTracerProvider`, registers it as the global provider, and returns a shutdown handle. Depends on `@ratel-ai/telemetry` for the vocabulary and the pure OTLP config resolution; re-exports `resolveOtlpConfig`, `InitOptions`, and `ResolvedOtlpConfig` for convenience.
