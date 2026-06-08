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
