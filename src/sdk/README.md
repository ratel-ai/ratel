# `src/sdk/`

Language SDKs that wrap `ratel-ai-core` so agents written in their respective host languages can drop the context engineering platform in with one dependency.

Each SDK bundles the core (binding strategy varies per language; see the relevant ADR) and exposes an idiomatic API for that ecosystem.

## Layout

```
ts/          @ratel-ai/sdk — TypeScript SDK
python/      ratel-ai — Python SDK
cloud/       @ratel-ai/cloud — TS catalog-source loader (protocol/v1 pull-sync)
cloud-py/    ratel-ai-cloud — Python catalog-source loader (protocol/v1 pull-sync)
```

Other languages land here when their milestones come up.

## `ts/` — `@ratel-ai/sdk`

The TypeScript SDK. Part of the pnpm workspace; bundles `ratel-ai-core` via a NAPI-RS native binding under [`ts/native/`](ts/native/README.md). See [`ts/README.md`](ts/README.md) for usage.

Binding strategy and tool-injection mode are locked in [ADR 0006](../../docs/adr/0006-native-ffi-bindings.md) and [ADR 0004](../../docs/adr/0004-retrieval-and-tool-selection.md).

## `python/` — `ratel-ai`

The Python SDK. Bundles `ratel-ai-core` via a [PyO3](https://pyo3.rs) native binding under [`python/native/`](python/native/README.md), distributed as prebuilt `abi3` wheels. Full feature parity with the TS SDK. See [`python/README.md`](python/README.md) for usage.

Binding strategy is locked in [ADR 0006](../../docs/adr/0006-native-ffi-bindings.md).

## `cloud/` — `@ratel-ai/cloud`

The TypeScript catalog-source loader: pull-syncs published skills from a networked source into a `SkillCatalog` over the frozen [protocol/v1](../../protocol/v1/README.md) contract. Pure TypeScript, no native binding. See [`cloud/README.md`](cloud/README.md).

The source seam is locked in [ADR 0003](../../docs/adr/0003-catalog-source-interface.md).

## `cloud-py/` — `ratel-ai-cloud`

The Python catalog-source loader, mirror of `cloud/`. Pure Python (stdlib HTTP, no runtime dependencies beyond `ratel-ai`). See [`cloud-py/README.md`](cloud-py/README.md).
