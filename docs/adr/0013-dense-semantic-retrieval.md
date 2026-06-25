# 13. Dense (semantic) retrieval via local Candle embeddings

Date: 2026-06-25

## Status

Proposed

## Context

BM25 ([ADR-0004](0004-bm25-tool-indexing.md)) is the retrieval floor: deterministic, in-process, no inference cost. But it is lexical — it can only rank a tool the query shares words with. The benchmark (`benchmark/RESULTS.md`) shows this is the dominant failure mode at realistic catalog sizes: on Sonnet at pool=180, **20 of 31 failures are "missing gold"** — the right tool never entered the candidate window because the query and the tool's description name the same concept with different words ("remove a file" vs. "delete a path"). No amount of BM25 tuning closes a synonymy gap.

Dense (semantic) retrieval embeds query and tool text into a shared vector space where paraphrases land near each other, so cosine similarity surfaces the gold tool that lexical overlap misses. The roadmap names this the next retrieval milestone, with the constraint that **BM25 stays the deterministic floor; semantic adds recall**, and that the core stays **in-process with no infra** (`src/core/lib/README.md`).

This ADR records the first dense slice, released as `ratel-ai-core` **0.3.0-semantic.1**. It is additive — it does not supersede ADR-0004, and reuses ADR-0004's flattened `searchable_text` as the embedding input (ADR-0004 already names the semantic-search milestone as a consumer of that contract).

## Decision

- **Runtime: [Candle](https://github.com/huggingface/candle)** (pure-Rust inference). No C++/ONNX native dependency, so the maturin wheels and napi addons stay clean across darwin/linux × arm64/x64 — avoiding the per-platform prebuilt-binary matching that ONNX Runtime would reintroduce. Inference speed is a non-issue: catalog vectors are **precomputed once at `register()`** (the indexed text never changes), so a search embeds only the query.
- **Model: `BAAI/bge-small-en-v1.5`** — BERT-family, 384-dim. Pooling is **CLS** (the `[CLS]` token of the last hidden state), then **L2-normalize**, so cosine similarity is a dot product. It is asymmetric: documents are embedded plain; the **query is prefixed** with `"Represent this sentence for searching relevant passages: "`. The embedder sits behind an `Embedder` trait, so MiniLM or a static model can be dropped in as alternate benchmark arms.
- **Storage: in-memory, no vector DB.** `ToolRegistry` holds a `Vec<Vec<f32>>` index-aligned with its tools. Ranking is brute-force cosine — at the benchmark's 30–200 tool pools this is trivially fast and keeps the "no infra" guarantee. Duplicate ids collapse to the latest vector, mirroring the BM25 engine's last-wins replace semantics.
- **Determinism.** Single-thread CPU, f32 compute, and a **pinned model revision** (HuggingFace commit SHA) so the same weights load on every machine. The cosine ranker reuses BM25's tie-break — sort by `(score desc, id asc)`, then truncate — so top-K membership is stable across processes regardless of input order.
- **Weights: downloaded on first use, cached, never in the repo.** On the first embedding, `hf-hub` fetches the model + tokenizer at the pinned revision into the shared HuggingFace cache (`~/.cache/huggingface`); every later run loads from cache, offline. The model is loaded once per process via `OnceLock` and kept resident — it serves *both* registration (`embed_doc`) *and* every query (`embed_query`), so it cannot be deleted after registration. `hf-hub` uses the sync `ureq`/rustls backend (no OpenSSL/native-tls), keeping wheels clean.
- **Feature-gated.** Everything lives behind a non-default `dense-search` cargo feature. BM25-only consumers (and the published `ratel-ai-core` crate) keep today's lean three-dependency build; the SDK native crates enable the feature so their wheels/addons expose `search_dense`. The crate and the wheels stay small — the model is fetched at runtime, not packaged.
- **API: additive.** New `ToolRegistry::search_dense` / `search_dense_with_origin` mirror the BM25 `search` signature (`(query, top_k) -> Vec<SearchHit>`) and emit the existing `TraceEvent::Search` with a stage named `"dense"` — no trace-schema change ([ADR-0009](0009-trace-events-core-owned-schema.md)). `search()` is untouched. Surfaced as `searchDense` (TS) / `search_dense` (Python).
- **Scope: tools only, dense-only.** Skills (`SkillRegistry`) and a BM25+dense **hybrid** fusion are deliberately out of scope for this release; the embedder is generic so both follow trivially.

## Consequences

- Recall on the "missing gold" cases should improve materially. The benchmark gains a `dense` retrieval arm (`recall@K` / `MRR` / `hit@K` on the same MetaTool pools, all else fixed per [ADR-0005](0005-benchmark-design.md)) to quantify it against the BM25 baseline before any default-path wiring.
- The default gateway path stays BM25; dense is opt-in for the benchmark this release. This keeps the deterministic floor in production while the dense arm is measured.
- The dense build adds a Candle compile and the `hf-hub` dependency, confined to the `dense-search` feature. The crate and wheels stay small — no weights are packaged.
- **First-run cost:** the first embedding triggers a one-time ~130 MB download and needs network; offline operation works only after that fetch populates the cache. CI runs should cache `~/.cache/huggingface` between jobs, or pre-warm it, to avoid re-downloading each run. This is the deliberate trade for not shipping a 64 MB blob in git.
- Because the model is fetched at runtime, the `dense-search` feature now *does* compile and work from a crates.io install — the earlier bundle-size limitation is gone.
- **Rejected — bundling the weights in the repo/binary (`include_bytes!`):** offline and zero first-run latency, but commits a 64 MB (f16) / 130 MB (f32) blob to git history permanently and bloats every clone. Download-on-first-use with a persistent cache trades a one-time fetch for a clean repo.
- **Rejected — ONNX Runtime (`ort`/`fastembed`):** faster and more turnkey, but links a per-platform C++ runtime that reintroduces the cross-compile/Rosetta packaging burden the project already fights. Throughput is the dimension that doesn't matter here (vectors are precomputed); distribution is the one that does.
- **Rejected — static embeddings (model2vec):** pure-Rust and faster still, but no contextual encoder, so it recovers less of the synonymy gap that motivates this work. Kept as a possible future benchmark arm behind the `Embedder` trait.
- **Rejected — ephemeral download (fetch, use, delete each run):** the model is needed for query embedding on *every* search, not just registration, so deleting it after registering would force a re-download per process. A persistent cache is the only coherent choice.
- **Rejected — vector database:** unjustified at 30–200 tool pools; brute-force cosine in memory is simpler and keeps the in-process guarantee. Revisit only if catalog scale (e.g. the 43k-tool ToolRet corpus) demands ANN.
- A superseding ADR will record the hybrid fusion (BM25 + dense), skill-side dense, and any move of dense onto the default path once the benchmark justifies it.
