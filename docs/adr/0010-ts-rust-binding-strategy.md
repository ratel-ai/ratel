# 10. TS↔Rust binding strategy

Date: 2026-04-29

## Status

Accepted (default-locked; spike deferred to Phase 2 prelude)

## Context

The TS SDK (`@ratel-ai/sdk`) needs to call into `ratel-core` (Rust). Four candidate strategies exist:

- **NAPI** — fast and natural for Node, but requires native artifacts per platform (CI matrix, prebuilt-binary distribution).
- **WASM** — solid cold-start and cross-platform, but Rust→WASM has limitations (no threads, awkward async story).
- **FFI** — bare metal; high maintenance burden.
- **HTTP-only** — easiest to ship, but introduces a server-required floor we want to avoid for lib-only mode.

See `docs/RATEL_V1_PLAN.md` §6.5 and `docs/RATEL_PHASE_0.md` §6.5 for the original framing.

## Decision

Default to **NAPI** for the TS SDK, with **HTTP-only as a fallback** for unsupported platforms. WASM stays on the table as a future option if NAPI distribution becomes painful.

This decision is locked at the documented default position rather than blocked on a Phase 0 spike. The cold-start spike — measuring NAPI vs WASM vs HTTP-only against the <50ms NFR (v1 plan §4.4) — is **deferred to a Phase 2 prelude**, where the binding actually starts mattering. Phase 0 prioritizes the retrieval/embedding spike (ADR 0009) for higher-blast-radius reasons.

## Consequences

- Phase 2 must start the binding work with the cold-start spike, *not* with NAPI integration. If measured cold-start exceeds the NFR, this ADR reopens and the choice may flip to WASM or HTTP-only.
- The CI matrix for the TS SDK must add per-OS jobs (macOS / Linux / Windows × Node 24) once NAPI artifacts start landing — out of scope for Phase 0.
- HTTP-only fallback is *not* a v1 shipping path — it's a contingency for platforms NAPI can't reach (e.g., obscure architectures). It does not mean every TS consumer can opt out of native artifacts.
- This ADR diverges from the Phase 0 doc's original "needs a real spike" treatment. The deviation is intentional; see the implementation plan's pre-decisions section.
