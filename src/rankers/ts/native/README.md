# `native/` — NAPI-RS binding to `ratel-ai-rankers`

The Rust crate that produces the native Node.js addon bundled by [`@ratel-ai/rankers-plugin`](../README.md). It exposes one `ChoiceRanker` class that takes a vendor id and wraps [`ratel-ai-rankers`](../../core/README.md)' `ranker_for`, so a new vendor needs no binding change. Ranker failures reach TS in a private `RATEL_RETRIEVER_ERROR:` envelope, which `src/adapter.ts` turns into the SDK's `RetrieverError`.

## Build

From the package root (`src/rankers/ts/`):

```bash
pnpm build:native
```

## Layout

```
Cargo.toml      cdylib crate; depends on ratel-ai-rankers via the workspace
build.rs        napi-build glue
src/lib.rs      ChoiceRanker (rankAsync on a libuv worker), vendors(), default model constants
```

The crate is a member of the top-level Cargo workspace, so `cargo build --workspace` picks it up.
