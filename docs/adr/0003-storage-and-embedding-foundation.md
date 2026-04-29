# 3. Storage + embedding foundation

Date: 2026-04-29

## Status

Accepted

## Context

Captures the v1 storage + embedding stack from `docs/RATEL_V1_PLAN.md` §5 and the §4.4 "embeddings run locally; no remote-API dependency at runtime" NFR. Phase 0's job here is to verify that the locked components actually compose: the SQLite extension we want for vector search must be license-compatible with our distribution model and loadable from Rust; the embedder we want must support the spike's model shortlist and ship a usable Rust crate.

The v1 plan's locked default was `sqlite-vector` (sqlite.ai) for the vector index, with `sqlite-vec` (asg017) as the documented fallback "if blocked." Initial Phase 0 verification flagged a license concern with sqlite-vector (Elastic License 2.0, modified for open-source use) — but the project itself subsequently adopted the same license posture as sqlite-vector (LICENSE.md), which dissolves the concern. The v1 plan's default stands.

## Decision

**Storage stack:**

- **SQLite** as the single-file storage default for both lib local-mode and the server (per v1 plan §5).
- **Vector index: `sqlite-vector`** ([sqlite.ai](https://www.sqlite.ai/sqlite-vector)) — the v1 plan's locked default. License: Elastic License 2.0 modified for open-source use, matching Ratel's own licensing posture (LICENSE.md). Compatible. Distributed as a prebuilt SQLite loadable extension (.so/.dylib/.dll, plus iOS/Android/WASM artifacts) via the project's GitHub releases. Loaded from Rust via `rusqlite`'s `load_extension` mechanism — no dedicated Rust crate exists, but loading prebuilt SQLite extensions is a well-supported rusqlite path. Uses regular SQLite tables (no virtual-table requirement), supports Float32/Float16/BFloat16/Int8/UInt8/1Bit, low memory footprint (~30MB default), SIMD-optimized C implementation.
- **Lexical index: SQLite FTS5** (built into SQLite; no external dependency). Paired with `sqlite-vector` so the hybrid retrieval cell is available in stage 1; the §6 #6 spike (ADR 0009) decides whether hybrid stays.

**Embedder stack:**

- **Embedder: `fastembed` Rust crate** (a.k.a. fastembed-rs, Apache 2.0). Bundles model loading via `pykeio/ort` (Rust ONNX bindings), `huggingface/tokenizers` for fast encoding, no Tokio dependency. Supports synchronous usage. Rust binaries link the crate; SDKs that wrap the binding tier (Phase 5 Python; the TS SDK once embeddings land) lazy-download model artifacts on first use per the v1 plan §5 distribution clause.
- **Local-only, no external override** — the v1 plan §4.4 NFR. Internal `Embedder` trait (defined alongside `Backend` per ADR 0004) is the seam for a future cloud variant; not a v1 plugin point.
- **Model shortlist for ADR 0009 spike — adjusted to fastembed-rs reality:** BGE-small-en-v1.5 (the crate's default), all-MiniLM-L6-v2, **Alibaba-NLP/gte-base-en-v1.5** (the v1 plan listed "GTE-small" but fastembed-rs ships gte-base/gte-large only — substituting `base`), **jinaai/jina-embeddings-v2-base-en** (v1 plan listed "jina-small"; fastembed-rs ships only the `base` variant of jina-v2). The spike will measure these four; the ADR 0009 write-up will note that "GTE-small" and "jina-small" from the v1 plan resolved to their closest fastembed-rs-supported variants. If the larger `base` variants blow the per-query CPU latency budget, the spike picks a smaller alternative from fastembed-rs's catalog (e.g., `intfloat/multilingual-e5-small`, `snowflake/snowflake-arctic-embed-xs`).

**Fallbacks (per v1 plan §5):**

- If `sqlite-vector` hits Rust integration friction during Phase 1 (e.g., extension-loading API breakage, prebuilt-binary distribution gaps for our CI matrix, breaking changes pre-v1), fall back to `sqlite-vec` (MIT/Apache-2.0, Mozilla Builders project, dedicated `sqlite-vec` Rust crate). The license posture is more permissive than ours; no compat concern. Postgres + pgvector is **not** in the fallback set for v1 — that's a v1.1 conversation tied to the §5 watch-out (SQLite single-writer scaling).
- If `fastembed-rs` blocks the chosen model, fall back to **Candle** (HuggingFace's Rust ML framework) for that model. Adds binary size and build complexity; defer until necessary.

**License/dependency audit summary:**

- `sqlite-vector`: Elastic License 2.0 (modified for open-source use). Same posture as Ratel's LICENSE.md — compatible. Published by SQLite Cloud, Inc.
- `fastembed`: Apache-2.0. Compatible.
- `pykeio/ort` (transitive via fastembed): Apache-2.0 / MIT. Compatible. Bundled prebuilt ONNX Runtime binaries available for macOS / Linux / Windows.
- `huggingface/tokenizers` (transitive via fastembed): Apache-2.0. Compatible.

## Consequences

- **End-to-end verification is part of the ADR 0009 spike.** §6.6's "Step 7 — verify sqlite-vector + fastembed-rs work for us" task confirms loadable-extension distribution works on macOS/Linux/Windows via rusqlite, the Rust integration story is smooth enough to use in Phase 1 production code paths, and the chosen embedding model runs end-to-end on a representative CPU. Outcome feeds back into both this ADR and ADR 0009.
- **The model shortlist deviates slightly from the v1 plan's literal text.** GTE-small → gte-base, jina-small → jina-base. These are larger-than-intended models; the spike's per-query CPU latency measurement will surface whether this matters for the <50ms NFR (v1 plan §4.4).
- The `fastembed` crate's default model is BGE-small-en-v1.5 — happens to align with ADR 0009's pre-spike default position. No code change needed if the spike confirms.
- ONNX Runtime ships as part of the `ort` crate's prebuilt binaries; no system-install requirement for end users. CI matrix needs no extra setup beyond standard `cargo build`.
- sqlite-vector's lack of a dedicated Rust crate means we own the rusqlite glue (extension-loading helper, schema bootstrap, etc.) in `core/lib`. Small surface; not a meaningful cost. Phase 1 lands this as part of `LocalBackend` impl.
- Both sqlite-vector and our fallback sqlite-vec carry "pre-v1, expect breaking changes" caveats in different forms. We pin specific versions in Cargo.toml / extension downloads; any upgrade is a deliberate decision.
- The embedder bundling story (Rust binary bundles; SDKs lazy-download) lands in Phase 1 as part of `LocalEmbedder` impl; this ADR locks the *what*, not the *how*.
