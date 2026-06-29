# 14. Drop the cross-encoder rerank stage from the hybrid pipeline

Date: 2026-06-29

## Status

Accepted

Supersedes the cross-encoder rerank decision in [ADR-0013](0013-hybrid-retrieval.md). The rest of ADR-0013 (BM25 + dense + RRF, embedding model, storage, determinism) stands.

## Context

[ADR-0013](0013-hybrid-retrieval.md) shipped the hybrid engine as `0.3.0-hybrid.1`: BM25 + dense fused with RRF, then a `cross-encoder/ms-marco-MiniLM-L6-v2` rerank as the final stage. Benchmarking that build showed hybrid scoring **worse than either BM25 alone or dense (bge-small) alone** — the rerank stage was actively degrading results, not improving them.

The mechanism is structural. The rerank stage produces the final order, replacing the RRF ranking outright. At the benchmark's pool sizes (~30–200 tools) the RRF candidate pool (`RERANK_POOL = 50`) often covered most or all of the corpus, so "hybrid" collapsed to *cross-encoder-ranking-the-whole-corpus* — and `ms-marco-MiniLM-L6-v2` (the smallest, oldest reranker, trained on natural-language MS MARCO passages) underperformed on this domain. It was also fed the flattened `searchable_text` projection (identifier/schema token soup), which a passage-trained cross-encoder handles poorly, while the bge bi-encoder tolerates it. A weak final arbiter caps the whole system at its own quality.

## Decision

- **Remove the cross-encoder rerank stage.** The hybrid pipeline is now `BM25 ∥ dense → RRF`, and **RRF is the final ranking**. `SearchHit.score` is the RRF fusion score (always positive).
- **Delete `reranker.rs`** and the `RERANK_POOL` constant. The dense embedder (`bge-small-en-v1.5`) and its Candle/tokenizers/hf-hub dependencies stay — they back the dense arm. Only the bi-encoder model is downloaded on first use now (~130 MB).
- **Trace stages** are `bm25`, `dense`, `rrf` (the `rerank` stage is gone) — additive/removal within the same event shape, no schema change ([ADR-0009](0009-trace-events-core-owned-schema.md)).
- The public `search()` / `search_with_origin()` signatures are **unchanged** — this is an internal pipeline change, transparent to callers.
- Released as `ratel-ai-core` **0.3.0-hybrid.2**.

## Consequences

- Hybrid no longer regresses below its own inputs: with the weak final arbiter gone, fused results track the stronger of BM25/dense rather than being capped by a poor reranker.
- Reranking is **not abandoned, only deferred.** A reranker can return behind the existing fusion stage once it earns its place on the benchmark. Candidates to revisit (per the benchmark discussion): a stronger model (`BAAI/bge-reranker-base`/`v2-m3`, mxbai, jina), feeding the reranker natural-language `name + description` instead of the flattened projection, reranking only a small top-N rather than the whole pool, or blending the rerank score with RRF instead of replacing it.
- One fewer model to download and no per-candidate forward pass at query time, so first-run cost and per-query latency both drop.
- A superseding ADR will record the reranker's return (with the model and integration that beat the RRF-only baseline) if and when the benchmark justifies it.
