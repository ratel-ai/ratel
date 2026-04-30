# `native/` — NAPI-RS binding to `ratel-core`

The Rust crate that produces the native Node.js addon bundled by [`@ratel-ai/sdk`](../README.md). Pure pass-through over the public API of [`ratel-core`](../../../core/lib/README.md); see [ADR 0002](../../../../docs/adr/0002-ts-rust-binding-strategy.md) for the binding-strategy rationale.

## Build

From the SDK package root (`src/sdk/ts/`):

```bash
pnpm build:native
```

Under the hood this runs `@napi-rs/cli` against this crate's `Cargo.toml`, producing a platform-specific `.node` binary plus a generated JS loader and `.d.ts` consumed by the TS source.

## Layout

```
Cargo.toml      cdylib crate; depends on ratel-core via the workspace
build.rs        napi-build glue
src/lib.rs      #[napi] wrappers for Tool, SearchHit, ToolRegistry
```

The crate is a member of the top-level Cargo workspace, so `cargo build --workspace` picks it up automatically.
