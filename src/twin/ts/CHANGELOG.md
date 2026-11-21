# Changelog

All notable changes to `@ratel-ai/twin` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this package adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `twin(id, { params, input, run, resolve? })` with `twin.model`, `twin.prompt`, `twin.int`, `twin.number`, `twin.bool`, `twin.enum`, `twin.string` and `twin.structured`.
- `resolveParams` / `runTwin`: per-run overrides checked against each param (`invalid_params`).
- `configHash` (SHA-256 of canonical JSON), `buildManifest` (protocol `twin/v1`), `callableProviders`.
- `resolveLocal(defaults, { twin })` and `stampTwinInput(input)`: the production stamps `ratel.twin.id`, `ratel.twin.config_hash` and `ratel.twin.input`.
- The `ratel` CLI: `ratel twin list` and `ratel twin run <id> --input <file> [--set k=v] [--tool t=mode]`, with user code in a child worker under `tsx`.
- `coerceOverride` turns `--set` text into the param's value type.
- `ratel dev`: token exchange, one outbound twin/v1 websocket, `register` with provider key names only, playground URLs, reconnect with a 1–60 s jittered backoff and a fresh token, and hot reload with `manifest.update`.
- `ratel dev` runs: idempotent `run.start` with `run.ack` / `run.reject`, `run.lease`, `run.event` by `seq` with resend of unacked events after a reconnect, `run.end` with the trace ID, `run.cancel` (aborts `ctx.signal`), make-before-break `drain` and frames of at most 64 KB.
- `ctx.log(message, level?)` and an optional `redact(payload)` on the twin definition.
- Playground traces: the `ratel dev` child exports each run to `/api/v1/traces` on the project's tracer provider (or the only one it registers), with the root span `invoke_workflow <twin id>`, the `ratel.twin.*` attributes and the playground resource. New constants `RATEL_TWIN_RUN_ID`, `RATEL_TWIN_OVERRIDES` and `RATEL_REPLAY_*`.
