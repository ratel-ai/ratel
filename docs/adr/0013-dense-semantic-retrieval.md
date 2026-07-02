# 13. Dense (semantic) retrieval via local Candle embeddings

Date: 2026-06-25

## Status

Proposed

## Context

BM25 ([ADR-0004](0004-bm25-tool-indexing.md)) is the retrieval floor: deterministic, in-process, no inference cost. But it is lexical — it can only rank a tool the query shares words with. The benchmark (`benchmark/RESULTS.md`) shows this is the dominant failure mode at realistic catalog sizes: on Sonnet at pool=180, **20 of 31 failures are "missing gold"** — the right tool never entered the candidate window because the query and the tool's description name the same concept with different words ("remove a file" vs. "delete a path"). No amount of BM25 tuning closes a synonymy gap.

Dense (semantic) retrieval embeds query and tool text into a shared vector space where paraphrases land near each other, so cosine similarity surfaces the gold tool that lexical overlap misses. The core stays **in-process with no infra** (`src/core/lib/README.md`); the embedding model runs locally.

This is released as `ratel-ai-core` **0.3.0-semantic.1**, the first version in a **retrieval-experiment line** where *the version is the experiment*: the benchmark (`ratel-bench`) compares retrieval methods by swapping the `ratel-ai-core` dependency version alone, with its own code frozen calling `.search()`. So `.search()` must *be* the experiment, not a sibling method:

```
v0.2.0            → .search() = BM25   (lexical baseline, already published)
v0.3.0-semantic.1 → .search() = dense  (this ADR)
v0.3.x            → .search() = hybrid → + rerank → …
```

In this version `.search()` is dense, unconditionally — **BM25 is removed from this line**; its version is v0.2.0. The embedding input reuses ADR-0004's flattened `searchable_text` (ADR-0004 already names the semantic-search milestone as a consumer of that contract). This does not supersede ADR-0004 — that BM25 design still describes v0.2.0.

## Decision

- **Runtime: [Candle](https://github.com/huggingface/candle)** (pure-Rust inference). No C++/ONNX native dependency, so the maturin wheels and napi addons stay clean across darwin/linux × arm64/x64 — avoiding the per-platform prebuilt-binary matching that ONNX Runtime would reintroduce. Inference speed is a non-issue: catalog vectors are **precomputed once at `register()`** (the indexed text never changes), so a search embeds only the query.
- **Model: `BAAI/bge-small-en-v1.5`** — BERT-family, 384-dim. Pooling is **CLS** (the `[CLS]` token of the last hidden state), then **L2-normalize**, so cosine similarity is a dot product. It is asymmetric: documents are embedded plain; the **query is prefixed** with `"Represent this sentence for searching relevant passages: "`. The embedder sits behind an `Embedder` trait, so MiniLM or a static model can be dropped in as alternate benchmark arms.
- **Storage: in-memory, no vector DB.** `ToolRegistry` holds a `Vec<Vec<f32>>` index-aligned with its tools. Ranking is brute-force cosine — at the benchmark's 30–200 tool pools this is trivially fast and keeps the "no infra" guarantee. Duplicate ids collapse to the latest vector, mirroring the BM25 engine's last-wins replace semantics.
- **Determinism.** Single-thread CPU, f32 compute, and a **pinned model revision** (HuggingFace commit SHA) so the same weights load on every machine. The cosine ranker sorts by `(score desc, id asc)`, then truncates — so top-K membership is stable across processes regardless of input order.
- **Weights: downloaded on first use, cached, never in the repo.** On the first embedding, `hf-hub` fetches the model + tokenizer at the pinned revision into the shared HuggingFace cache (`~/.cache/huggingface`); every later run loads from cache, offline. The model is loaded once per process via `OnceLock` and kept resident — it serves *both* registration (`embed_doc`) *and* every query (`embed_query`). `hf-hub` uses the sync `ureq`/rustls backend (no OpenSSL/native-tls), keeping wheels clean.
- **No feature flag — `.search()` is dense.** `search` / `search_with_origin` on both `ToolRegistry` and `SkillRegistry` run the dense pipeline (embed query → cosine over the precomputed `Vec<Vec<f32>>` → top-K), emitting the existing `Search` / `SkillSearch` trace event with a stage named `"dense"` — no trace-schema change ([ADR-0009](0009-trace-events-core-owned-schema.md)). There is no `search_dense` method and no `dense-search` cargo feature; Candle, `hf-hub`, and `tokenizers` are ordinary dependencies. This is what lets the benchmark swap engines by version alone. The signature is unchanged, so the SDK's existing `search` (TS/Python) is now dense automatically.
- **Scope: tools and skills.** Dense ranking is the engine on both registries (the benchmark exercises tools via BFCL and skills via SR-Agents). A BM25+dense **hybrid** is a *later version* in this line (`.search()` = hybrid), which reintroduces BM25 scoring (restorable from v0.2.0 / git history); the `Embedder` trait also leaves room for alternate models.

## Consequences

- Recall on the "missing gold" cases should improve materially. The benchmark compares **version vs version** — point its frozen `ratel-bench` at v0.2.0 (`.search()` = BM25) vs this version (`.search()` = dense) and compare `recall@K` / `MRR` / `hit@K` on the same pools, all else fixed per [ADR-0005](0005-benchmark-design.md). No bench code changes; the dependency version is the arm.
- **`.search()` semantics differ by version** (BM25 in 0.2.0, dense here). This is intentional — the version *is* the experiment. Production consumers pin a version deliberately; this is a prerelease experiment line, not a drop-in upgrade of 0.2.0.
- **The whole crate and the SDK now pull Candle + `hf-hub` and use dense `.search()`.** There is no lean BM25 build of this version. The SDK wheels/addons ship dense; the gateway's `search_capabilities` is dense. Accepted cost of "version = engine."
- **First-run cost:** the first embedding triggers a one-time ~130 MB model download and needs network; offline operation works only after the cache is populated. The default `cargo test` and the SDK suites need network on first run; CI should cache `~/.cache/huggingface` between jobs, or pre-warm it.
- **Rejected — bundling the weights in the repo/binary (`include_bytes!`):** offline and zero first-run latency, but commits a 64 MB (f16) / 130 MB (f32) blob to git history permanently and bloats every clone. Download-on-first-use with a persistent cache trades a one-time fetch for a clean repo.
- **Rejected — ONNX Runtime (`ort`/`fastembed`):** faster and more turnkey, but links a per-platform C++ runtime that reintroduces the cross-compile/Rosetta packaging burden the project already fights. Throughput is the dimension that doesn't matter here (vectors are precomputed); distribution is the one that does.
- **Rejected — static embeddings (model2vec):** pure-Rust and faster still, but no contextual encoder, so it recovers less of the synonymy gap that motivates this work. Kept as a possible future benchmark arm behind the `Embedder` trait.
- **Rejected — ephemeral download (fetch, use, delete each run):** the model is needed for query embedding on *every* search, not just registration, so deleting it after registering would force a re-download per process. A persistent cache is the only coherent choice.
- **Rejected — vector database:** unjustified at 30–200 tool pools; brute-force cosine in memory is simpler and keeps the in-process guarantee. Revisit only if catalog scale (e.g. the 43k-tool ToolRet corpus) demands ANN.
- **Rejected — a separate `search_dense` method (additive, `search` stays BM25):** clean for SDK users, but it breaks the benchmark's version-only comparison — swapping the version never changes what the frozen bench's `.search()` does, so the experiment never runs. The experiment must *be* `.search()`.
- **Rejected — gating dense behind a `dense-search` feature (BM25 stays the default):** preserves a lean BM25 build, but then `.search()` means different things in the same version depending on a compile flag, and the bench would have to set that flag. "Version = engine" is simpler and is what was chosen; the BM25 build is just an earlier version.
- A superseding ADR (a later version in this line) records the BM25+dense **hybrid** and reranking, restoring BM25 scoring as a fusion input.
