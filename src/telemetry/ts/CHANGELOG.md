# Changelog

All notable changes to `@ratel-ai/telemetry` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this package adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Initial scaffold of the telemetry helper (ADR-0015): the pinned OpenTelemetry `gen_ai` semconv version and the `ratel.*` span vocabulary as constants. The full attribute/enum vocabulary and the `init()` OTLP builder follow.
