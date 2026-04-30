# `@ratel-ai/sdk`

TypeScript SDK for [Ratel](../../../README.md) — the context engineering platform for AI agents. Wraps `ratel-core` (Rust) so JS/TS agents can drop Ratel in with one dependency.

## Install

```bash
npm install @ratel-ai/sdk
# or
pnpm add @ratel-ai/sdk
```

## Package shape

- Package name: `@ratel-ai/sdk`
- ESM only (`"type": "module"`)
- Bundles `ratel-core` via NAPI-RS ([ADR 0002](../../../docs/adr/0002-ts-rust-binding-strategy.md))
- Tool-list injection defaults to `replace` ([ADR 0003](../../../docs/adr/0003-tool-selection-replace-vs-suggest.md))

## Build & test

Part of the pnpm workspace at the repo root. From this folder:

```bash
pnpm build       # tsc → dist/
pnpm typecheck
pnpm lint        # biome
pnpm test        # vitest
```

Or run against the whole workspace from the repo root with `pnpm -r <script>`.
