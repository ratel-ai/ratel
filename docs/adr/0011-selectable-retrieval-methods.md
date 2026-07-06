# 11. Selectable retrieval methods: BM25, semantic, hybrid

Date: 2026-07-06

## Status

Accepted

Builds on ADR-0004 (retrieval: the `searchable_text` projection and BM25 scorer), which
anticipated a semantic ranker merging with the lexical signal. ADR-0006 (native FFI bindings)
and ADR-0007 (telemetry schema) frame how the choice surfaces through the SDKs and traces.

## Context

BM25 is the shipped ranker. Two parallel spikes each replaced it wholesale — one with dense
(semantic) retrieval over a local embedding model, one with a BM25+dense hybrid. Neither
coexistence nor selection existed: each was the single engine on its branch.

Users need all three at once, choosing per deployment. BM25 must stay the default and stay
model-free: it needs no download, never fails, and many callers neither want nor can run a
local model. Semantic and hybrid must be opt-in, and their one cost — loading the embedding
model — must not leak into a BM25-only process.

## Decision

**A `SearchMethod` enum — `Bm25` (default) | `Semantic` | `Hybrid` — selects the ranker.** It
is chosen per catalog (a construction-time default) or per call (an explicit override); the
override wins. Across the SDKs the identifier is the string `"bm25" | "semantic" | "hybrid"`,
parallel to `SearchOrigin`.

- **BM25** is unchanged from ADR-0004 (`bm25_search`, `k1 = 0.9`, `b = 0.4`) and stays the
  default. The legacy `search` / `search_with_origin` entry points keep their infallible
  `Vec<SearchHit>` signature and BM25 behavior byte-for-byte — upgrading callers need no code
  change.
- **Semantic** embeds the query with a local `BAAI/bge-small-en-v1.5` model (pure-Rust Candle,
  pinned revision, CLS-pool + L2-normalize) and cosine-ranks it against embedded tool/skill
  text (`dense_search`). The same `searchable_text` projection feeds it.
- **Hybrid** runs the BM25 and dense arms to a fixed retrieval depth and fuses their rankings
  by **Reciprocal Rank Fusion** (`RRF_K = 60`), no cross-encoder reranker. RRF fuses on rank
  position, so BM25's unbounded scores and cosine's `[-1, 1]` never need reconciling.
- **Fallibility is confined to the new path.** A method-carrying `search_with_method` returns
  `Result<_, EmbedderError>`; `Bm25` is always `Ok`, while `Semantic`/`Hybrid` surface a failed
  model load (network, cache, underpowered machine) as a catchable error — a Python
  `RuntimeError` / a thrown JS error at the SDK edge.
- **Embeddings load lazily.** A registry embeds its corpus on the first semantic/hybrid search
  and caches it (invalidated on `register`); a pure BM25 user never loads the model. The
  one-time load emits a `TraceEvent::EmbedderLoad` flagging a slow (possibly underpowered) or
  failed load.

## Consequences

- The default stays lightweight and infallible; the ML dependency (Candle, tokenizers with the
  pure-Rust `fancy-regex` backend, `hf-hub`) is compiled in but never exercised unless a caller
  opts into semantic/hybrid. The `searchable_text` contract (ADR-0004) is unchanged, so all
  three engines rank the same projection.
- The external MCP gateway package, which calls the catalog with no method argument, inherits
  the catalog's construction-time default — a deployment picks its engine without upgrading
  that package.
- The ML native deps (`ring`, Candle's `esaxx-rs`) do not zig-cross-compile, so the linux-arm64
  SDK binaries build on a native ARM64 runner instead of `--use-napi-cross`.
- Rejected: a compile-time feature flag to pick the engine (the earlier spikes' shape) —
  runtime selection is required for per-call and per-catalog choice, and for one binary serving
  all three. Rejected: eager embedding at `register` — it would force a model load (and make
  `register` fallible) on every user, including BM25-only ones. Rejected: score-normalization
  fusion for hybrid — RRF needs no per-arm score calibration.
