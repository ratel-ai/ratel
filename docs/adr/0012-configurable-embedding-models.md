# 12. Configurable embedding models

Date: 2026-07-10

## Status

Accepted

Extends ADR-0011 (selectable retrieval methods), which fixed the semantic/hybrid
arms to a single hardcoded model. Builds on ADR-0006 (native FFI bindings) and
ADR-0007 (telemetry schema) for how the choice surfaces through the SDKs and traces.

## Context

ADR-0011 shipped semantic/hybrid retrieval against one pinned model,
`BAAI/bge-small-en-v1.5`, as two `const`s loaded through a process-global
singleton. Users cannot bring their own: a larger or multilingual HuggingFace
model, an air-gapped local checkpoint, or a model served over HTTP (OpenAI,
Ollama, TEI, vLLM). BM25 must stay model-free and the zero-config default must
stay byte-for-byte identical.

## Decision

**The embedding model is configurable per catalog, declared once at
construction, via an `EmbeddingModel` enum resolved from a cross-SDK spec.** The
model is used for *both* document and query embedding, so the two sides can never
land in different vector spaces.

- **Four sources.** `Default` (the pinned bge-small, unchanged); `HuggingFace {
  repo, revision }` and `Local { path }` — BERT-family models run in-process via
  Candle; `Endpoint { url, model, api_key_env }` — an OpenAI-compatible
  `/embeddings` HTTP call (OpenAI, **Ollama**, TEI, vLLM), the only path that
  supports non-BERT models. `revision` is optional (defaults to `main`).
- **Explicit source, no `kind` field.** A bare string is a **local model
  directory path**; every other source is an object whose *key* names it —
  `{huggingface}` / `{local}` / `{ollama}` / `{url, model}` — symmetric across
  the board (a repo-id-looking or URL string is rejected with a pointer to the
  right object form, rather than guessed). Resolution and all validation live in
  **core** (`EmbeddingModel::resolve`), shared by both SDKs rather than
  duplicated; config errors surface at construction. Windows drive paths (`C:\…`)
  are never mistaken for URLs (the URL rule requires `://`).
- **Per-catalog, deduplicated by identity.** The global one-model singleton
  becomes a process-wide cache **keyed by model fingerprint**, so two catalogs on
  the same model still load it once, while different models coexist. A failed
  load is not cached (retries), preserving ADR-0011's non-poisoning contract.
- **Three correctness guards** against silently-wrong cosine results — the danger
  when vectors from different models/dimensions are ranked together, which does
  not error on its own. (1) **Normalize at the embedder boundary**: every vector
  from any source is L2-normalized before it reaches the cache or `dense_search`,
  so an endpoint returning un-normalized vectors can't break the cosine==dot
  assumption. (2) **Dimension mismatch is a hard `EmbedderError`** (the cache
  stamps its width; a query or doc of another width is rejected, never
  zip-truncated). (3) **Model-identity drift is a non-blocking warning** (a trace
  event + stderr): the cache stamps the fingerprint that built it, and a query
  under a different model warns "rebuild with build_embeddings()" but proceeds.
- **Endpoint specifics.** `api_key_env` names the env var holding the key (read
  at call time), keeping secrets out of code and serialized config; a
  named-but-unset var is a clear error, not a downstream 401. `embed_batch` sends
  one request per batch (registration embeds the whole corpus — per-doc
  round-trips would be pathological). A 404 from a localhost Ollama hints
  `ollama pull <model>`. A single sync `ureq` client with a timeout, so a stalled
  endpoint can't hang registration.
- **Ratel auto-downloads only the built-in default.** An explicitly-configured
  HuggingFace model is **cache-only**: it must already be in the local HF cache,
  or the caller opts in with `download=true`. A missing one errors as
  `EmbedderError::NotCached` with a `huggingface-cli download …` hint — symmetric
  with Ollama's "not pulled", so a `register()` never silently pulls a multi-GB
  model on the user's behalf. When a download *does* happen (the default, or an
  opt-in), a cold fetch emits a `TraceEvent::EmbedderDownload` with the **actual
  byte size** plus a stderr notice, so it is never silent.
- **Non-BERT in an in-process source** (`local`/`huggingface`) fails
  `BertModel::load` with a typed error that **signposts the endpoint/Ollama
  route** — turning a dead end into a pointer.

## Consequences

- The default path is unchanged and stays reproducible (SHA-pinned); BM25 remains
  model-free (an `embedding` set with `method="bm25"` warns and is ignored). One
  new direct dependency, `ureq` (already in-tree via hf-hub, rustls — no new
  transitive cost, keeps ADR-0011's clean cross-platform wheels).
- BERT-family models run in-process (Candle's `bert`), pooled the way they were
  trained: **pooling (CLS/mean) is auto-detected** from the repo's
  `1_Pooling/config.json`, with a `pooling` override and a warn-then-assume-Mean
  fallback when a model ships no pooling metadata — so mainstream
  sentence-transformers models (bge, e5, gte, MiniLM, mpnet) rank correctly, not
  just the CLS-pooled bge family. Asymmetric models are supported on both sides
  (`query_prefix` + `doc_prefix`), and weights load from `model.safetensors` or a
  `pytorch_model.bin` fallback. Every non-BERT model — nomic, Qwen-embed,
  GGUF-only — still runs via a local or hosted **endpoint**. We accept this rather
  than reintroduce an ONNX/C++ runtime, which would reverse ADR-0011's
  clean-wheels decision.
- **Known limitation, not addressed here:** the embedding cache is in-process
  only, so every process start re-embeds the corpus — cheap for a local model,
  but real latency and cost over an endpoint. A **persistent on-disk embedding
  cache** is the natural follow-up; the model-fingerprint stamped on the cache is
  the invalidation key it will need. Also deferred: async/non-blocking downloads,
  non-OpenAI endpoint request shapes, and in-process GGUF/ONNX.
- The model-drift warning is latent under today's in-process, model-immutable
  cache (drift can't occur within one process); it is wired and unit-tested now
  so it is live the moment a persisted/shared cache exists.
