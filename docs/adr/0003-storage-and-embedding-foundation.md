# 3. Storage + embedding foundation

Date: 2026-04-29

## Status

Accepted

## Context

Captures the v1 storage + embedding stack from `docs/RATEL_V1_PLAN.md` §5 and the §4.4 "embeddings run locally; no remote-API dependency at runtime" NFR. Phase 0's job here is to verify that the locked components actually compose: the SQLite extension we want for vector search must be license-compatible with our open-core distribution and loadable from Rust; the embedder we want must support the spike's model shortlist and ship a usable Rust crate.

The v1 plan's locked default was `sqlite-vector` (sqlite.ai) for the vector index, with `sqlite-vec` (asg017) as the documented fallback "if blocked." Verification during Phase 0 identified the trigger condition.

## Decision

**Storage stack:**

- **SQLite** as the single-file storage default for both lib local-mode and the server (per v1 plan §5).
- **Vector index: `sqlite-vec`**, the v1-plan-documented fallback. The originally-locked `sqlite-vector` (sqlite.ai) is licensed under **Elastic License 2.0** (modified for open-source use). ELv2 prohibits providing the software as a managed service, which is borderline for Ratel's self-hostable open-core posture and introduces non-trivial license-compatibility analysis that we don't want load-bearing in v1. `sqlite-vec` is dual MIT/Apache-2.0 (no compatibility risk), Mozilla Builders-sponsored, pure C with no system dependencies, has a published `sqlite-vec` Rust crate (`cargo add sqlite-vec`), and runs everywhere SQLite runs. The "pre-v1, expect breaking changes" caveat is real but acceptable for a v1 ship — we pin a specific version and upgrade deliberately.
- **Lexical index: SQLite FTS5** (built into SQLite; no external dependency). Paired with `sqlite-vec` so the hybrid retrieval cell is available in stage 1; the §6 #6 spike (ADR 0009) decides whether hybrid stays.

**Embedder stack:**

- **Embedder: `fastembed` Rust crate** (a.k.a. fastembed-rs, Apache 2.0). Bundles model loading via `pykeio/ort` (Rust ONNX bindings), `huggingface/tokenizers` for fast encoding, no Tokio dependency. Supports synchronous usage. Rust binaries link the crate; SDKs that wrap the binding tier (Phase 5 Python; the TS SDK once embeddings land) lazy-download model artifacts on first use per the v1 plan §5 distribution clause.
- **Local-only, no external override** — the v1 plan §4.4 NFR. Internal `Embedder` trait (defined alongside `Backend` per ADR 0004) is the seam for a future cloud variant; not a v1 plugin point.
- **Model shortlist for ADR 0009 spike — adjusted to fastembed-rs reality:** BGE-small-en-v1.5 (the crate's default), all-MiniLM-L6-v2, **Alibaba-NLP/gte-base-en-v1.5** (the v1 plan listed "GTE-small" but fastembed-rs ships gte-base/gte-large only — substituting `base`), **jinaai/jina-embeddings-v2-base-en** (v1 plan listed "jina-small"; fastembed-rs ships only the `base` variant of jina-v2). The spike will measure these four; the ADR 0009 write-up will note that "GTE-small" and "jina-small" from the v1 plan resolved to their closest fastembed-rs-supported variants.

**Fallbacks (per v1 plan §5):**

- If `sqlite-vec` blocks (e.g., the breaking-changes caveat hits us hard during Phase 1), evaluate: stay on `sqlite-vec` and pin earlier; or move to a Rust-side ANN index (e.g., `instant-distance` or `hnsw`). Postgres + pgvector is **not** in the fallback set for v1 — that's a v1.1 conversation tied to the §5 watch-out (SQLite single-writer scaling).
- If `fastembed-rs` blocks the chosen model (e.g., a future spike picks a model the crate doesn't support), fall back to **Candle** (HuggingFace's Rust ML framework) for that model. Adds binary size and build complexity; defer until necessary.

**License/dependency audit summary:**

- `sqlite-vec`: MIT or Apache-2.0 (consumer's choice). Compatible with Ratel's SUL + MIT carve-out (LICENSE.md).
- `fastembed`: Apache-2.0. Compatible.
- `pykeio/ort` (transitive via fastembed): Apache-2.0 / MIT. Compatible. Bundled prebuilt ONNX Runtime binaries available for macOS / Linux / Windows.
- `huggingface/tokenizers` (transitive via fastembed): Apache-2.0. Compatible.

## Consequences

- **The v1 plan's `sqlite-vector` default is superseded by `sqlite-vec` based on the documented fallback condition.** The v1 plan's table in §5 should be updated in a follow-up doc edit to reflect `sqlite-vec` as the locked choice and capture the ELv2 trigger as historical context. (Doc edit is a separate PR; this ADR is the load-bearing decision record.)
- **The model shortlist deviates slightly from the v1 plan's literal text.** GTE-small → gte-base, jina-small → jina-base. These are larger-than-intended models; the spike's per-query CPU latency measurement will surface whether this matters for the <50ms NFR (v1 plan §4.4). If it does, the spike picks a smaller alternative from fastembed-rs's catalog (e.g., `intfloat/multilingual-e5-small`, `snowflake/snowflake-arctic-embed-xs`).
- The `fastembed` crate's default model is BGE-small-en-v1.5 — happens to align with ADR 0009's pre-spike default position. No code change needed if the spike confirms.
- ONNX Runtime ships as part of the `ort` crate's prebuilt binaries; no system-install requirement for end users. CI matrix needs no extra setup beyond standard `cargo build`.
- "Pre-v1 with breaking changes" on `sqlite-vec` means we pin the version in `Cargo.toml` (no caret ranges that auto-bump major), and any upgrade is a deliberate decision tracked separately.
- The embedder bundling story (Rust binary bundles; SDKs lazy-download) lands in Phase 1 as part of `LocalEmbedder` impl; this ADR locks the *what*, not the *how*.
