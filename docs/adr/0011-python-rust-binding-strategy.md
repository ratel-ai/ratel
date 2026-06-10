# 11. Python↔Rust binding strategy

Date: 2026-06-08

## Status

Accepted

## Context

The Python SDK (`ratel-ai` on PyPI) has to call into `ratel-ai-core` (Rust), the same core the TS SDK binds. We want a single Python package consumers can `pip install` with one dependency, that runs `ratel-ai-core` *in-process* (no infra), with negligible cold-start overhead — the same constraints ADR-0002 set for the TS SDK. The candidate strategies mirror that decision:

- **PyO3 + maturin** — Rust → Python native extension module via the CPython C-API. Fast, in-process; requires per-platform prebuilt wheels (CI matrix + binary distribution). `abi3` (the stable ABI) collapses the per-Python-version matrix to one wheel per platform.
- **WASM** (wasmtime / Pyodide) — Rust → WebAssembly loaded from Python. Cross-platform single artifact; weaker async/threads story, heavier cold-start for non-trivial Rust. Same tradeoffs ADR-0002 flagged for the TS side.
- **HTTP sidecar** — Python calls `ratel-ai-core` over local HTTP. Easiest to ship; introduces a server-required floor the project explicitly avoids for lib-only mode (see the roadmap's "Out of scope").

This is the exact problem ADR-0002 solved for TypeScript, where it locked **NAPI-RS**. PyO3 is the Python analogue of NAPI-RS: a mature, idiomatic native-extension framework with a maintained build tool (`maturin`) and a well-trodden prebuilt-wheel distribution path.

## Decision

Default to **PyO3 + maturin** for the Python SDK, distributing prebuilt **`abi3` wheels** (stable ABI, `abi3-py39` floor) per platform on PyPI, with **HTTP-only as a contingency fallback** for platforms PyO3/maturin can't reach. WASM stays on the table if per-platform wheel distribution becomes painful in practice — symmetric with ADR-0002's WASM contingency for TS.

The native crate lives at `src/sdk/python/native/` as a Cargo workspace member, `crate-type = ["cdylib"]`, depending on `ratel-ai-core` via the workspace — structurally identical to `src/sdk/ts/native/`. It is a **pure pass-through** over the public API of `ratel-ai-core`; all execution/gateway/MCP logic lives in the pure-Python layer above it, exactly as the TS SDK keeps that logic in TypeScript.

## Consequences

- The Python SDK's build pipeline needs a per-OS prebuilt-wheel CI matrix over the same five targets the TS SDK already builds (darwin-arm64, darwin-x64, linux-x64-gnu, linux-arm64-gnu, win32-x64-msvc). `PyO3/maturin-action` handles the cross/manylinux matrix.
- **`abi3` collapses the Python-version axis**: one wheel per platform serves all CPython ≥ 3.9, rather than a wheel per (platform × Python version). Fewer artifacts than a non-abi3 matrix.
- Cold-start overhead for a PyO3 native module load is microsecond-scale — well within budget, matching the NAPI finding in ADR-0002. If real-world numbers diverge, this ADR reopens.
- HTTP-only fallback is *not* a shipping path — it's a contingency for unsupported architectures, mirroring ADR-0002. It does not mean every Python consumer can opt out of native wheels.
- The trace-event schema stays core-owned (ADR-0009): the Python binding emits the same `TraceEvent` shapes the TS SDK does, so a single reranker trains on the union of TS- and Python-emitted events with no translation layer.
- Mature precedent: `pydantic-core`, `polars`, `cryptography`, `ruff`, and `tokenizers` all ship Rust to Python via PyO3 + maturin with prebuilt wheels. Tooling and abi3 distribution patterns are well-trodden.
- Version alignment (ADR-0008): `ratel-ai` ships at the same workspace semver as `ratel-ai-core`, `@ratel-ai/sdk`, and `@ratel-ai/cli`; the release pipeline enforces it.
