# 27. Custom retriever and reranker functions, and a two-stage reranker

Date: 2026-10-03

## Status

Proposed. Accepted once `ratel-bench` has measured Jev as a retriever and as a reranker against
local `bm25` / `hybrid`, as [ADR-0024](0024-hybrid-fuses-on-scores.md) was.

Builds on [ADR-0011](0011-selectable-retrieval-methods.md) (selectable methods; its "no
cross-encoder reranker" is lifted here) and [ADR-0014](0014-adaptive-usage-ranking.md) (the usage
arm).

## Context

Every ranker Ratel ships scores a query against tool text it holds in-process: BM25, dense
cosine, or the two fused. Nothing reorders their output; the only re-ranking is the usage arm.

"System-one" decision models pick the right option for a query from a closed set in a few
hundred milliseconds. Jev (TypeSafe AI) returns a probability per option for up to 255 options;
on a payments catalog it picks the refund tool BM25 ranks sixth, at ~0.9, in ~0.4 s. OpenAI's
Decisions API is in limited preview and returns a single pick; open-source decision models are
appearing.

Unlike embeddings, these models share no wire format. The OpenAI-compatible embeddings API is a
de facto standard many servers speak, so `embedding: { url }` can stay generic. Jev's request
format is one vendor's and could change completely in a v2; a config option such as
`systemOne: { url, apiKeyEnv }` would bind every SDK release to it. Ratel Cloud's Tool Picker is
a second such ranker, and Cloud-specific features belong in `@ratel-ai/cloud-sdk`, not here.

## Decision

**1. The SDK ranks through functions it is given; it knows no model's interface.** One contract
serves both hooks:

```ts
type RankFn = (query: string, candidates: { id; kind: "tool" | "skill"; text }[], topK: number)
  => Promise<{ id; score }[]> | { id; score }[];

new ToolCatalog({ method: "custom", retrieveFn });          // the function ranks the whole catalog
new ToolCatalog({ method: "bm25", rerankerFn, rerankerDepth: 20 }); // it reranks stage 1's top 20
```

`text` is the item's `searchable_text` (ADR-0004, ADR-0021), the text the built-in methods rank.
Python spells them `retrieve_fn`, `reranker_fn`, `reranker_depth`; a function may be sync or
async. Tool and skill catalogs and `ratel()` take them; facts do not (`ratel()` ranks facts with
BM25 when `method` is `"custom"`). `"custom"` and a `rerankerFn` are async-only.

**2. Core runs the phases; the SDK calls the function between them.** Rust cannot call back into
JavaScript or Python mid-search, so the registries expose two phases:
`rank_candidates` → `complete_custom_search`, and `stage_one` → `complete_rerank`. Completion
validates what the function returned: unknown ids dropped, each id once, scores clamped to
`[0, 1]` (non-finite reads as 0). A retriever returns only the ids it returned, best first, at most
`top_k`. A reranker never widens stage 1's set; candidates it left out follow at 0, and ties keep
stage 1's order. One search event is recorded, with a `custom` stage, or stage 1's stages plus
`rerank`.

**3. A built-in two-stage reranker.** `reranker: { method, depth = 50 }` re-scores stage 1's top
`max(depth, top_k)` with another built-in method (`bm25`, `semantic`, `hybrid`; not the first
stage's own). BM25 keeps corpus-wide IDF. The usage arm runs in stage 1 only. `reranker` and
`rerankerFn` are mutually exclusive; per call, `reranker: null` (Python `False`) turns either off.

**4. Failure is the function's to classify.** A retriever's error fails the search. A
reranker's `RetrieverError` with `transient: true` keeps stage 1's order and records
`rerank_fallback:<code>`; anything else fails the search. `RetrieverError { code, transient,
status?, retryAfterSecs? }` is generic, so any model's function can use it. A search that fails
records no `search` event on the local trace stream, as a failed built-in search does not: the
error surfaces to the caller and on the `ratel.search` span (status ERROR) when telemetry is on.
Only the transient reranker fallback, which still returns hits, is recorded.

**5. Jev ships as a plugin over the hooks.** `ratelJevPlugin({ url?, apiKeyEnv?, model? })`
(Python `ratel_jev_plugin`) returns `{ retrieve, rerank }`. Its client lives in core's `jev.rs`
(`JevRanker`) outside the search path, with the defaults `https://api.typesafe.ai`,
`TYPESAFE_API_KEY` (read at call time) and `jev-latest`. It asks one `choice` question per call
(question id `tool` or `skill`), above 150 options or 80,000 characters runs groups of that size
in parallel (6 at a time) and fills a final question with their winners round-robin. It drops
picks below probability 0.01 (keeping the best one), so a retriever returns real picks rather than
zero-score filler. Its failures
map to `RetrieverError` codes: `Config`, `Unauthorized`, `InvalidRequest` (not transient);
`RateLimited` (with `Retry-After`), `Overloaded`, `Timeout`, `Unreachable`, `Http`, `Malformed`
(transient). A change to Jev's API touches the plugin only.

**6. The Cloud Tool Picker is not in this SDK.** It belongs in `@ratel-ai/cloud-sdk` (for
example `ratelCloud({ apiKey }).toolPicker` as a `retrieveFn`), as Cloud features will until the
SDKs merge.

## Consequences

- No model's wire format reaches the search path. A new model is a function, or a plugin like
  Jev's; neither needs a change to the catalogs.
- **A function sends whatever it sends.** The Jev plugin sends the query and each candidate's
  searchable text to TypeSafe AI; the built-in methods never leave the process.
- Each custom search costs the function's latency; a reranker's cost grows with `depth`, not
  catalog size.
- Rejected: `systemOne: { url, apiKeyEnv, model }` and `method: "systemOne"` (the first cut of
  this ADR) — they tie the SDK to Jev's interface with no standard to point at. Rejected:
  `cloud: { mode }` on the catalogs with snapshot sync on `register` — Cloud-specific, so
  cloud-sdk. Rejected: calling back into JavaScript or Python from Rust mid-search — threadsafe
  callbacks into an async function block a worker on the event loop; the two-phase API keeps
  core synchronous.
