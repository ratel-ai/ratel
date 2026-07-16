# `src/sdk/`

Language SDKs that wrap `ratel-ai-core` so agents written in their respective host languages can drop the context engineering platform in with one dependency.

Each SDK bundles the core (binding strategy varies per language; see the relevant ADR) and exposes an idiomatic API for that ecosystem.

## Layout

```
ts/                @ratel-ai/sdk — TypeScript SDK
python/            ratel-ai — Python SDK
local-skills/      @ratel-ai/local-skills — reference SKILL.md directory loader (TS)
```

## `ts/` — `@ratel-ai/sdk`

The TypeScript SDK. Part of the pnpm workspace; bundles `ratel-ai-core` via a NAPI-RS native binding under [`ts/native/`](ts/native/README.md). See [`ts/README.md`](ts/README.md) for usage.

Binding strategy and tool-injection mode are documented in [ADR 0006](../../docs/adr/0006-native-ffi-bindings.md) and [ADR 0004](../../docs/adr/0004-retrieval-and-tool-selection.md).

## `python/` — `ratel-ai`

The Python SDK. Bundles `ratel-ai-core` via a [PyO3](https://pyo3.rs) native binding under [`python/native/`](python/native/README.md), distributed as prebuilt `abi3` wheels. Full feature parity with the TS SDK. See [`python/README.md`](python/README.md) for usage.

Binding strategy is documented in [ADR 0006](../../docs/adr/0006-native-ffi-bindings.md).

## `local-skills/` — `@ratel-ai/local-skills`

The reference catalog loader: hydrates a `SkillCatalog` from a directory of `<name>/SKILL.md` files (default `~/.ratel/skills`). Ships as a separate package so the SDK stays dependency-lean, the first implementation of the loader seam ([ADR 0003](../../docs/adr/0003-catalog-source-interface.md), [ADR 0005](../../docs/adr/0005-first-class-skills.md)). See [`local-skills/README.md`](local-skills/README.md) for usage.
