# `src/sdk/`

Language SDKs that wrap `ratel-ai-core` so agents written in their respective host languages can drop the context engineering platform in with one dependency.

Each SDK bundles the core (binding strategy varies per language; see the relevant ADR) and exposes an idiomatic API for that ecosystem.

## Layout

```
ts/        @ratel-ai/sdk — TypeScript SDK
python/    ratel-ai — Python SDK
cloud/     @ratel-ai/cloud — Ratel Cloud client (pure TS, no native code)
```

Other languages land here when their milestones come up.

## `ts/` — `@ratel-ai/sdk`

The TypeScript SDK. Part of the pnpm workspace; bundles `ratel-ai-core` via a NAPI-RS native binding under [`ts/native/`](ts/native/README.md). See [`ts/README.md`](ts/README.md) for usage.

Binding strategy and tool-injection mode are locked in [ADR 0002](../../docs/adr/0002-ts-rust-binding-strategy.md) and [ADR 0003](../../docs/adr/0003-tool-selection-replace-vs-suggest.md).

## `python/` — `ratel-ai`

The Python SDK. Bundles `ratel-ai-core` via a [PyO3](https://pyo3.rs) native binding under [`python/native/`](python/native/README.md), distributed as prebuilt `abi3` wheels. Full feature parity with the TS SDK. See [`python/README.md`](python/README.md) for usage.

Binding strategy is locked in [ADR 0011](../../docs/adr/0011-python-rust-binding-strategy.md).

## `cloud/` — `@ratel-ai/cloud`

Client for Ratel Cloud over a per-project API key: trace-event export, skill-catalog pull/cache sync, suggestion review, and coarse run metrics. Pure TypeScript (`@ratel-ai/sdk` is a peer dependency; no native code). See [`cloud/README.md`](cloud/README.md) for usage.

Sync/export semantics are locked in [ADR 0013](../../docs/adr/0013-trace-envelope-context-and-cloud-export.md) and [ADR 0014](../../docs/adr/0014-cloud-catalog-sync-and-suggestions.md).
