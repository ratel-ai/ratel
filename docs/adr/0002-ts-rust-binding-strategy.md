# 2. TS↔Rust binding strategy

Date: 2026-04-30

## Status

Accepted

## Context

The TS SDK (`@ratel-ai/sdk`) has to call into `ratel-core` (Rust). We want a single TS package consumers can drop in with one dependency, that runs `ratel-core` *in-process* (no infra), with negligible cold-start overhead. Four candidate strategies:

- **NAPI-RS** — Rust → Node native module via N-API. Fast, in-process; requires per-platform prebuilt artifacts (CI matrix + binary distribution).
- **WASM** — Rust → WebAssembly. Cross-platform single artifact; weaker async story, no threads, heavier cold-start for non-trivial Rust.
- **FFI** — bare `dlopen` / `node-ffi-napi`. NAPI without the ergonomics; high maintenance.
- **HTTP-only** — TS calls `ratel-core` over HTTP. Easiest to ship; introduces a server-required floor we explicitly want to avoid for lib-only mode.

v0.1.0 doesn't ship a binding yet — but we lock the choice now so v0.1.1 (BM25 retrieval) starts with a known starting point.

## Decision

Default to **NAPI-RS** for the TS SDK, with **HTTP-only as a contingency fallback** for platforms NAPI can't reach. WASM stays on the table if NAPI's per-platform distribution becomes painful in practice.

## Consequences

- The TS SDK's build pipeline needs a per-OS prebuilt-binary CI matrix (macOS / Linux / Windows × Node 24+) once binding work lands. Out of scope for v0.1.0.
- Cold-start overhead for a NAPI native module load is microsecond-scale — well within any reasonable budget. If real-world numbers diverge, this ADR reopens.
- HTTP-only fallback is *not* a v1 shipping path — it's a contingency for unsupported architectures. It does not mean every TS consumer can opt out of native artifacts.
- Mature precedent: `swc`, `turbopack`, `parcel`, `biome`, `lightningcss` all ship Rust to Node via NAPI-RS. Tooling and prebuilt-binary patterns are well-trodden.
