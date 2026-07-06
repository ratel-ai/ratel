# 6. Native FFI bindings: NAPI-RS for TS, PyO3 for Python

Date: 2026-07-05

## Status

Accepted

Compacted 2026-07 from pre-compaction ADR-0002 (TS binding, 2026-04-30) and ADR-0011 (Python
binding, 2026-06-08).

## Context

Both language SDKs call into `ratel-ai-core` and share the same constraints: one dependency a
consumer drops in, the kernel running in-process (no infra), negligible cold-start. The
candidates in both ecosystems mirror each other: a native extension (NAPI-RS / PyO3), WASM
(single artifact, weaker async/threads, heavier cold-start), or HTTP to a sidecar (introduces
the server-required floor the library exists to avoid).

## Decision

- **TS: NAPI-RS.** Per-platform prebuilt binaries; the native crate at `src/sdk/ts/native/`.
- **Python: PyO3 + maturin**, distributing prebuilt **`abi3` wheels** (stable ABI, py39
  floor), so one wheel per platform serves all CPython ≥ 3.9; the native crate at
  `src/sdk/python/native/`, `crate-type = ["cdylib"]`.
- Both native crates are **pure pass-throughs** over the public API of `ratel-ai-core`; all
  execution / gateway / MCP logic lives in the pure-language layer above.
- Both build the same five targets: darwin-arm64, darwin-x64, linux-x64-gnu, linux-arm64-gnu,
  win32-x64-msvc.
- **HTTP-only is a contingency** for platforms the native path cannot reach, not a shipping
  path, and not an opt-out from native artifacts. It is distinct from the remote catalog
  source: `RATEL_URL` selects a loader that hydrates the local registries, and retrieval
  still runs in-process through these bindings ([ADR-0003](0003-catalog-source-interface.md)).
- WASM stays on the table if per-platform distribution becomes painful in practice.

## Consequences

- Each SDK carries a per-OS prebuilt-artifact CI matrix; the TS loader pins its five platform
  packages exactly (the internal-lockstep invariant,
  [ADR-0008](0008-release-engineering.md)).
- Native module load is microsecond-scale on both sides; if real-world numbers diverge, this
  ADR reopens.
- Mature precedent on both paths: swc / turbopack / biome via NAPI-RS; pydantic-core /
  polars / ruff / tokenizers via PyO3 + maturin.
