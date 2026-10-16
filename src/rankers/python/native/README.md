# `native/` — PyO3 binding to `ratel-ai-rankers`

The Rust crate that produces the native extension bundled by [`ratel-ai-rankers-plugin`](../README.md), importable as `ratel_ai_rankers_plugin._native`. It exposes one `ChoiceRanker(vendor, url=None, api_key_env=None, model=None)` class over [`ratel-ai-rankers`](../../core/README.md)' `ranker_for`, plus a `RankerError` exception. The plugin adapter re-raises that exception as `ratel_ai.RetrieverError`.

## Layout

```
Cargo.toml      cdylib crate (abi3-py39); depends on ratel-ai-rankers via the workspace
src/lib.rs      ChoiceRanker (rank with the GIL released), RankerError, vendors(), default model constants
```

The crate is a member of the top-level Cargo workspace. Like the SDK's binding, it sets `test = false`: the Python test suite exercises it. `maturin` turns on the `extension-module` feature for wheels.
