# 4. Lib architecture — `Backend` interface as the seam

Date: 2026-04-29

## Status

Accepted

## Context

Ratel's lib must work in two modes — local-only (single-process, SQLite, zero infra) and remote (talks to `ratel-server` for cross-session learning, central token vault, fleet observability). The lib's public API cannot branch on `if (server)`; that pattern leaks the deployment topology into every call site and ages badly. See `docs/RATEL_V1_PLAN.md` §3 and §4.4.

## Decision

The lib is built around a single trait, **`Backend`**, that abstracts persistence + cross-session-state interactions. Two implementations ship in v1:

- **`LocalBackend`** — SQLite (`sqlite-vector` + FTS5 per ADR 0003) or in-memory. Default; required for the lib-only floor.
- **`RemoteBackend`** — talks to `ratel-server` over the transport chosen in ADR 0007. Opt-in via env var or config; lights up cross-session features.

The lib's public API accepts an injected `Backend`. Server-only features live in a subpath (`@ratel-ai/sdk/server-features` for TS) so tree-shaking handles bundling for lib-only consumers.

The `Backend` trait is **backwards-compatible** as a hard requirement (NFR in v1 plan §4.4). Adding the v1.1 `context/` module (chat/memory management) must be additive — new methods with default impls, not signature changes to existing methods.

A parallel **`Embedder`** trait is the seam for the embedding subsystem (see ADR 0003 and the v1 plan's §4.4 NFR on local embeddings). It is *internal*: a future cloud variant can swap implementations transparently, but no external/user-supplied embedder is exposed in v1.

## Consequences

- Tests can use a fake `Backend` without spinning up a server.
- The local↔remote distinction is one config switch, not a code change.
- Future Postgres-backed remote backend, alternative storage engines, etc. fit cleanly behind the same trait — each becomes another impl, not an architectural break.
- The "no signature changes to existing `Backend` methods" rule is load-bearing for the v1.1 chat/memory ship. Code review must enforce it.
- `Embedder` is a trait but **not** a v1 plugin point — see the no-override-in-v1 stance documented across ADR 0003 and Out-of-Scope sections of the Phase 0 plan.
