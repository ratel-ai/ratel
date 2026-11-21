# Changelog

All notable changes to `@ratel-ai/twin` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this package adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `twin(id, { params, input, run, resolve? })` with `twin.model`, `twin.prompt`, `twin.int`, `twin.number`, `twin.bool`, `twin.enum`, `twin.string` and `twin.structured`.
- `resolveParams` / `runTwin`: per-run overrides checked against each param (`invalid_params`).
- `configHash` (SHA-256 of canonical JSON), `buildManifest` (protocol `twin/v1`), `callableProviders`.
- `resolveLocal(defaults, { twin })` and `stampTwinInput(input)`: the production stamps `ratel.twin.id`, `ratel.twin.config_hash` and `ratel.twin.input`.
