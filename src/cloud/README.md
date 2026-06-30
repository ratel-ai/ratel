# `src/cloud/`

The Ratel Cloud telemetry product: developers send **agent events** — the request/response of a single
LLM call — to a remote Ratel endpoint, where they power cost, quality, and debugging dashboards. The
data is exactly what a dev already assembles for a provider SDK, reshaped once into a unified schema.

Why a folder of its own, separate from `core/` and `sdk/`: the schema and its clients are one product
with a shared contract (the [conformance fixtures](fixtures/)) and a distinct architecture from the
gateway — pure-language clients with no native addon, so they run on edge/serverless. The decision and
its rationale are in [ADR-0013](../../docs/adr/0013-cloud-telemetry-unified-schema.md).

## Layout

```
fixtures/   shared conformance JSON vectors (valid/ + invalid/) — the cross-language contract
core/       ratel-ai-cloud — Rust crate, the canonical schema + validation (source of truth)
ts/         @ratel-ai/cloud — pure-TypeScript client
python/     ratel-ai-cloud — pure-Python client
```

## How it fits together

`core/` is the spec: the event types, serde, and strict validation, owned in Rust and directly usable by
Rust/server consumers. The clients in `ts/` and `python/` **mirror** that spec in pure language — types,
a validator, and a non-blocking batching transport — and are kept honest by replaying the shared
`fixtures/` in CI. No client loads a native addon, and none depends on the gateway SDK.

`core/`'s `dump_fixtures` example regenerates `fixtures/valid/` from the canonical types; the three
conformance suites (one per language) replay every fixture, so drift between the mirrors and the spec
fails CI rather than slipping into production.
