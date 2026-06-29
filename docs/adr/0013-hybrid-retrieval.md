# 13. Hybrid retrieval — BM25 + dense fused with RRF, then a cross-encoder rerank

Date: 2026-06-29

## Status

Accepted

## Context

BM25 ([ADR-0004](0004-bm25-tool-indexing.md)) is the retrieval floor: deterministic, in-process, no inference cost. But it is lexical — it can only rank a tool the query shares words with. The benchmark shows this is the dominant failure mode at realistic catalog sizes: the right tool never enters the candidate window because the query and the tool's description name the same concept with different words ("remove a file" vs. "delete a path"). No amount of BM25 tuning closes a synonymy gap.

A dense (semantic) arm — embedding query and tool text into a shared vector space where paraphrases land near each other — recovers that recall, but on its own it loses BM25's precision on exact-term and identifier matches. The two are complementary: BM25 is precise where words overlap, dense is robust where they don't. The standard way to get both is to **fuse** their rankings and then **rerank** the fused candidates with a model that scores the `(query, document)` pair jointly.

This ADR records that engine, released as `ratel-ai-core` **0.3.0-hybrid.1**. It does not supersede ADR-0004 — it reuses ADR-0004's flattened `searchable_text` as the input to every stage (ADR-0004 already names the semantic-search milestone as a consumer of that contract). The constraint from the core README holds: **in-process, no infra**.

## Decision

- **Hybrid is the default and only retrieval path.** The public `search()` / `search_with_origin()` on `ToolRegistry` and `SkillRegistry` keep their exact signatures and now run the hybrid pipeline. A caller upgrading from a BM25-only release changes no code; retrieval upgrades transparently. There are no `search_bm25` / `search_dense` public arms — BM25 and dense are internal stages (`bm25_search`, `dense_search` stay `pub(crate)`).

- **Pipeline:** `query → BM25 (lexical) ∥ dense (semantic) → RRF fusion → cross-encoder rerank → top_k`. Both arms retrieve `RETRIEVE_DEPTH = 100` candidates so fusion has rank signal beyond `top_k`; RRF caps the merged set at `RERANK_POOL = 50` for the reranker, which scores each candidate and produces the final order. Each stage is recorded as a `SearchStage` (`"bm25"`, `"dense"`, `"rrf"`, `"rerank"`) on the existing `Search` / `SkillSearch` trace event — additive, no schema change ([ADR-0009](0009-trace-events-core-owned-schema.md)).

- **Fusion: Reciprocal Rank Fusion (RRF), `k = 60`.** `score(id) = Σ 1/(k + rank)` over the BM25 and dense rankings. RRF fuses on *rank position*, not raw scores, so it sidesteps the incomparable scales of BM25 (unbounded) and cosine (`[-1, 1]`) with no per-query normalization to tune. `k = 60` is the Cormack et al. (2009) default. Rejected — score normalization + weighted sum (min-max / z-score): needs a per-corpus calibration that RRF avoids, and is sensitive to outlier scores.

- **Dense embedder: `BAAI/bge-small-en-v1.5`** — BERT-family, 384-dim, **CLS** pooling, **L2-normalized** (so cosine is a dot product), **asymmetric** (the query is prefixed with `"Represent this sentence for searching relevant passages: "`; documents are embedded plain). Behind an `Embedder` trait so the model is swappable.

- **Cross-encoder reranker: `cross-encoder/ms-marco-MiniLM-L6-v2`** — `BertForSequenceClassification`, 6 layers, 384-hidden, a single-logit relevance head (default activation Identity, so the raw logit *is* the score; higher = more relevant). Candle's `BertModel` provides the encoder; the pooler (`bert.pooler.dense`, dense+tanh) and classifier (`classifier`, hidden→1) heads are loaded by hand from the same safetensors. The pair is encoded `[CLS] query [SEP] doc [SEP]` with real segment ids. The cross-encoder runs only over the bounded `RERANK_POOL` (one forward pass per candidate, query-time only), never the whole corpus and never at registration. Behind a `Reranker` trait, mirroring the embedder. The final `SearchHit.score` is the cross-encoder logit.

- **Runtime: [Candle](https://github.com/huggingface/candle)** (pure-Rust inference). No C++/ONNX native dependency, so the maturin wheels and napi addons stay clean across darwin/linux × arm64/x64 — avoiding the per-platform prebuilt-binary matching ONNX Runtime would reintroduce. Both models run single-thread CPU in f32.

- **Storage: in-memory, no vector DB.** Each registry holds a `Vec<Vec<f32>>` of dense embeddings index-aligned with its tools/skills, **precomputed once at `register()`** (the indexed text never changes; a search embeds only the query). Ranking is brute-force cosine — trivially fast at the benchmark's 30–200 tool pools and keeps the "no infra" guarantee. The reranker needs *text*, not vectors, so candidate text is re-derived with `searchable_text` at query time. Duplicate ids collapse to the latest entry on every arm, mirroring the BM25 engine's last-wins replace semantics. Rejected — a vector database: unjustified at these pool sizes; revisit only if catalog scale (e.g. a 43k-tool corpus) demands ANN.

- **Determinism.** Single-thread CPU, f32 compute, and **pinned model revisions** (HuggingFace commit SHAs) so the same weights load on every machine. Every stage — BM25, dense, RRF, rerank — sorts by `(score desc, id asc)` then truncates, so top-K membership is stable across processes regardless of input order.

- **Weights: downloaded on first use, cached, never in the repo.** On first embedding/rerank, `hf-hub` fetches each model + tokenizer at its pinned revision into the shared HuggingFace cache (`~/.cache/huggingface`); every later run loads from cache, offline. Each model is loaded once per process via `OnceLock` and kept resident. `hf-hub` uses the sync `ureq`/rustls backend (no OpenSSL/native-tls), keeping wheels clean. Rejected — bundling the weights (`include_bytes!`): commits a multi-hundred-MB blob to git and bloats every clone.

- **Dependencies are mandatory, not feature-gated.** Candle, tokenizers, and hf-hub are non-optional dependencies of `ratel-ai-core`; the SDK native crates inherit them with no extra wiring. The crate version is the experiment: 0.2.0 = BM25, 0.3.0-hybrid.1 = hybrid, so the benchmark swaps retrieval engines by dependency version alone.

## Consequences

- Recall on the "missing gold" synonym cases improves materially, and the rerank stage tightens precision over either arm alone. The benchmark gains a `hybrid` arm (`recall@K` / `MRR` / `hit@K` on the same pools, all else fixed per [ADR-0005](0005-benchmark-design.md)) to quantify it against the BM25 and dense baselines.
- `SearchHit.score` is now a cross-encoder relevance logit (unbounded, can be negative), not a BM25 score. Callers that ranked by relative order are unaffected; any that thresholded on the absolute BM25 value must recalibrate.
- Per-query cost is now BM25 + one query embedding + up to `RERANK_POOL` cross-encoder forward passes. Registration cost is unchanged beyond the one-time document embedding. Bounded and acceptable at 30–200 catalog sizes; `RETRIEVE_DEPTH` / `RERANK_POOL` are the tuning knobs if the benchmark shows drift.
- **First-run cost:** the first search triggers a one-time download of both models (~220 MB total) and needs network; offline operation works only after that fetch populates the cache. CI must cache `~/.cache/huggingface` between jobs, or pre-warm it, to avoid re-downloading each run.
- The published bare crate now pulls the Candle stack and is no longer the lean three-dependency BM25 library it was at 0.2.0 — the deliberate trade for hybrid being the default everywhere, SDKs included.
- A superseding ADR will record any change to the fusion strategy, the model choices, or a move to ANN if catalog scale demands it.
