# `native/` — PyO3 binding to `ratel-ai-core`

The Rust crate that produces the native Python extension bundled by [`ratel-ai`](../README.md). Pure pass-through over the public API of [`ratel-ai-core`](../../../core/README.md); see [ADR 0006](../../../../docs/adr/0006-native-ffi-bindings.md) for the binding-strategy rationale.

## Build

From the SDK package root (`src/sdk/python/`), inside a venv with `maturin` installed:

```bash
maturin develop          # build + install the extension into the active venv
maturin build --release  # build a release abi3 wheel
```

Under the hood `maturin` compiles this crate (with the `extension-module` feature) into a platform-specific `abi3` extension importable as `ratel_ai._native`.

## Layout

```
Cargo.toml      cdylib crate; depends on ratel-ai-core via the workspace
src/lib.rs      #[pyclass] / #[pymethods] wrappers for ToolRegistry, SearchHit, SkillRegistry, SkillHit
```

The crate is a member of the top-level Cargo workspace, so `cargo build --workspace` picks it up automatically. Plain `cargo build` / `cargo test` build *without* the `extension-module` feature, so the cdylib links libpython and a standalone workspace build/test doesn't fail resolving Python symbols at runtime; `maturin` enables the feature for wheels. The crate ships no Rust tests of its own — `Cargo.toml` sets `test = false` / `doctest = false`, and the binding is exercised from the Python test suite — so `cargo test` builds, but runs zero tests here.
