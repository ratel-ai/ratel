# `src/sdk/`

Language SDKs that wrap `ratel-ai-core` so agents written in their respective host languages can drop the context engineering platform in with one dependency.

Each SDK bundles the core (binding strategy varies per language; see the relevant ADR) and exposes an idiomatic API for that ecosystem.

## Layout

```
ts/    @ratel-ai/sdk — TypeScript SDK
```

Other languages (Python, etc.) land here when their milestones come up.

## `ts/` — `@ratel-ai/sdk`

The TypeScript SDK. Part of the pnpm workspace; bundles `ratel-ai-core` via a NAPI-RS native binding under [`ts/native/`](ts/native/README.md). See [`ts/README.md`](ts/README.md) for usage.

Binding strategy and tool-injection mode are locked in [ADR 0002](../../docs/adr/0002-ts-rust-binding-strategy.md) and [ADR 0003](../../docs/adr/0003-tool-selection-replace-vs-suggest.md).
