# 26. System-one ranking and a two-stage reranker

Date: 2026-10-01

## Status

Proposed. Accepted once `ratel-bench` has measured `hybrid`, `hybrid → systemOne` and standalone
`systemOne` against the live Ratel Cloud endpoint, as [ADR-0024](0024-hybrid-fuses-on-scores.md)
was.

Builds on [ADR-0011](0011-selectable-retrieval-methods.md) (selectable methods; its "no
cross-encoder reranker" is lifted here), [ADR-0012](0012-configurable-embedding-models.md)
(endpoint configuration shape) and [ADR-0014](0014-adaptive-usage-ranking.md) (the usage arm).

## Context

Every ranker Ratel ships scores a query against tool and skill text it holds in-process: BM25,
dense cosine, or the two fused. Nothing reorders their output; the only re-ranking is the usage
arm, which boosts what agents actually invoked.

A new class of hosted "system-one" models picks the correct option for a query from a closed set
in ~100–300 ms:

- **Jev** (TypeSafe AI) — `POST /v1/systemone` with a `choice` question whose criteria map up to
  **255** option names to descriptions. It returns the argmax plus a **probability for every
  option**, so a full ranking is one sort. State plus the longest question must fit 32k tokens;
  $0.042 per million input tokens. Its published cookbooks rerank BM25 shortlists and select
  skills from a 182-item catalog, both with large accuracy gains.
- **OpenAI Decisions API** — announced 2026-09-29, limited preview, no public docs. As described
  it returns **one** answer from a predefined set; scores and a ranked list are unconfirmed.

Both shapes are "rank these candidates for this query". Providers will differ in candidate limits,
whether they return scores, auth and pricing, and more will appear.

## Decision

**1. `systemOne` is a fourth `SearchMethod`.** Identifier `"systemOne"` in the SDKs (`"systemone"`
also parses). Like semantic it is fallible and async-only: synchronous `search` rejects it.

**2. Core calls one Ratel Cloud contract; providers live behind it.** The SDKs and core carry no
provider code. Defaults: `https://app.ratel.sh/v1/systemone`, bearer key from `RATEL_API_KEY`. A
catalog may override both with `systemOne: { url, apiKeyEnv }` — the ADR-0012 endpoint shape —
for staging, self-hosted proxies and tests.

```jsonc
// request
{ "query": "refund the last order",
  "candidates": [{ "id": "stripe_refund", "text": "<searchable_text>" }],
  "top_k": 5 }
// response
{ "ranked": [{ "id": "stripe_refund", "score": 0.88 }],
  "provider": "jev", "model": "jev-1.13.0" }
```

Candidate `text` is the existing `searchable_text` projection (or the ADR-0021
`experimental_searchable_description` override), so all four methods rank the same text. Core
validates the response: unknown ids dropped, duplicates removed, scores clamped to `[0, 1]`,
truncated to `top_k`. In core the client sits behind a crate-private `SystemOne` trait, so a
direct-to-provider implementation can be added later without an API change.

**3. Server-side, one generic driver over provider adapters.** Each adapter declares
`max_candidates` and ranks one chunk. Above the limit the driver ranks chunks in parallel, keeps
each chunk's top `top_k`, and runs a final round over the winners. Jev maps candidates to
index-keyed criteria (`t0…tN`) and sorts the returned probabilities. A provider that returns a
single pick "promotes the winner": it goes first, the rest keep their input order — which, as a
reranker, is stage 1's order.

**4. A two-stage reranker, generic over all four methods.** `reranker: { method, depth = 50 }`
re-scores stage 1's top `depth` with any of `bm25 | semantic | hybrid | systemOne`:

- The stage-2 score replaces stage 1's; `SearchHit` keeps its shape.
- BM25 as a reranker keeps **corpus-wide** IDF — recomputing it over 50 candidates would distort
  scores. Semantic uses the candidates' cached vectors; hybrid applies ADR-0024 score fusion over
  the candidate set.
- The usage arm (ADR-0014) applies in stage 1 only, so it is not counted twice.
- The same method in both stages is a configuration error. `depth < top_k` is raised to `top_k`.
- If either stage is semantic or hybrid, `register()` builds embeddings, as today.
- A failed `systemOne` rerank returns stage 1's order and records the error on a `rerank` trace
  stage. A failed standalone `systemOne` search raises a typed `SystemOneError`.

**5. Additive surfaces.** Existing `search_with_method*` keep their signatures and
`EmbedderError`; a new `search_with_options` returns a `SearchError` covering embedder,
system-one and configuration failures. `SearchMethod` gains a variant and becomes
`#[non_exhaustive]` in the same core minor release, so later methods are additive. The SDK
surfaces are marked experimental in docs and CHANGELOG.

**Not in this decision:** conversation context as model input, the usage arm on standalone
`systemOne`, server-side catalog caching, and a direct-to-provider client.

## Consequences

- **Data leaves the process.** With `systemOne` selected, the query and every candidate's text go
  to Ratel Cloud and from there to the provider. The other three methods stay in-process; the SDK
  READMEs say so prominently.
- Each `systemOne` search adds a network round trip (~150–400 ms for ≤255 candidates, one more
  round above that) and a per-token cost. Standalone mode sends the whole catalog on every query;
  as a reranker only `depth` candidates are sent.
- Adding a provider is a server-side adapter: no SDK or core release.
- The reranker is useful without the cloud: `bm25 → semantic` gives a cheap lexical prefilter
  in front of dense scoring.
- `SearchMethod` gaining a variant breaks exhaustive matches in downstream Rust; core takes a
  minor bump.

## Rejected

- **Configuring a provider on the catalog** (`experimentalSystemOne: { jev: {...} }`). It puts
  provider keys and provider code in every SDK and needs a release per provider.
- **A host callback** (`systemOne: async (query, candidates) => ranked`). It is flexible, but
  needs two implementations (TS and Python) of chunking, validation and error handling, and
  invites per-host drift.
- **A system-one-only reranker.** Users asked for any method in either stage; the candidate
  re-scoring core needs is the same for all four.
