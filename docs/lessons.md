# Lessons

Accumulated rules from things Claude (or a contributor) got wrong. Each entry prevents the next occurrence — every mistake becomes a rule the agent and the team carry forward.

**Read this at the start of every session.** Append to it whenever a new rule is needed; don't edit existing entries to soften them.

## Format

```
### YYYY-MM-DD: <short title>
- **Situation**: what happened
- **Rule**: the precise instruction that prevents it next time
- **Why**: (optional) the underlying reason — helps judge edge cases
```

Keep entries short. If a rule grows beyond ~5 lines, promote it to an ADR or a dedicated doc and link from here.

## Rules

### 2026-06-08: PyO3 `extension-module` feature must stay opt-in for `cargo` to work
- **Situation**: The Python SDK's native crate (`src/sdk/python/native`) is a Cargo workspace member. Enabling `pyo3/extension-module` unconditionally makes the cdylib skip linking libpython, which breaks plain `cargo build --workspace` / `cargo test` (the CI `rust.yml` gate) on the symbols.
- **Rule**: Put `extension-module` behind a crate feature (`[features] extension-module = ["pyo3/extension-module"]`) that **maturin enables for wheels** (`[tool.maturin] features = [...]`), and leave it OFF for `cargo`. Then `cargo` links libpython and runs; `maturin` builds importable wheels.
- **Why**: An extension module resolves Python symbols against the host interpreter at import time, so it must NOT link libpython — but a standalone `cargo` build/test has no host interpreter, so it must. The feature flag lets one crate serve both.

### 2026-06-08: the `mcp` Python package needs Python ≥ 3.10 — keep it an optional extra
- **Situation**: `ratel-ai` targets an `abi3-py39` floor, but the `mcp` client requires Python ≥ 3.10. Making `mcp` a hard dependency would have forced the whole SDK to 3.10+.
- **Rule**: Keep MCP ingestion behind the `ratel-ai[mcp]` extra and lazily `import mcp` inside `register_mcp_server` (raise a clear install hint if absent). Base retrieval/catalog/gateway stay installable on 3.9+.
- **Why**: Parity with the TS SDK is about surface, not dependency coupling — the function exists either way; only the upstream-MCP path needs the heavier, newer dependency.

### 2026-06-09: porting `await` from the TS SDK is not literal — handle sync + async executors in one tested place
- **Situation**: The pydantic-ai example mirrored TS's `await execute(args)` for catalog tools. In JS, `await` on a non-Promise is a harmless no-op; in Python `await {dict}` raises `TypeError`. So sync executors (the BM25 top-K stubs) crashed on every call — masked because the async gateway/MCP executors awaited fine and diagnostic mode never fired a tool.
- **Rule**: `Executor` is `sync | async` by design (simple tools stay sync; MCP/HTTP tools are genuinely async — `await session.call_tool`). When porting to any language, dispatch every tool through that language's `ToolCatalog.invoke`, which must accept both kinds (Python: call then `inspect.isawaitable`; never bare-`await`). Examples must route through `invoke`, not re-derive it, and ship a model-free test that actually invokes a tool.
- **Why**: `await`/promise semantics differ across languages, so the dual-mode handling belongs in one tested function, not copied to each call site. A "smoke run" that stops before any tool fires (e.g. diagnostic mode) is not coverage of the tool-call path.

### 2026-06-25: scope a non-SemVer prerelease version to the crate that ships it — `maturin` rejects it workspace-wide
- **Situation**: Releasing `ratel-ai-core` as `0.3.0-semantic.1` by bumping `[workspace.package] version` broke `maturin develop`: the Python native crate inherits the workspace version via `version.workspace = true`, and `maturin` derives the wheel's Python version from it — `0.3.0-semantic.1` is valid Cargo SemVer but not PEP 440, so it fails to parse.
- **Rule**: When a Cargo prerelease tag (`-semantic.N`, `-rc.N`, etc.) is scoped to one crate, set `version = "..."` on that crate's `[package]` directly and leave `[workspace.package] version` (which the SDK native crates inherit) on a PEP 440-clean value. Don't bump the workspace version for a single-crate prerelease.
- **Why**: Cargo SemVer and PEP 440 prerelease grammars differ; maturin bridges them, so any version a Python-binding crate inherits must satisfy both.

### 2026-06-25: `#[cfg]` on a single `#[napi]` method leaves a dangling callback — gate the whole impl block
- **Situation**: Adding `#[cfg(feature = "dense-search")]` to one `#[napi]` method inside a `#[napi] impl` block failed the default `cargo clippy --workspace` with `E0425: cannot find value 'search_dense_c_callback'`. The `#[napi]` impl macro emits callback registrations for its methods; the method-level `cfg` strips the method but not the generated registration.
- **Rule**: To feature-gate a napi method, put it in its own `#[cfg(...)] #[napi] impl T { ... }` block. The item-level `cfg` strips the whole block (registration included) before the macro runs. (PyO3's `#[pymethods]` handles method-level `cfg` correctly — this is napi-specific.)
- **Why**: `cfg` on an item is resolved before the proc-macro on that item expands, so an outer-block `cfg` removes the macro invocation entirely; a method-level `cfg` runs after the impl-level macro has already emitted the dangling reference.
