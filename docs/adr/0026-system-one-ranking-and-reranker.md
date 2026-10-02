# 26. System-one ranking — the Cloud Tool Picker and Jev direct — and a two-stage reranker

Date: 2026-10-01 (revised 2026-10-02)

## Status

Proposed. Accepted once `ratel-bench` has measured the three picker modes against local
`bm25` / `hybrid`, as [ADR-0024](0024-hybrid-fuses-on-scores.md) was.

Revised 2026-10-02: the first draft had the SDK own the catalog and send candidates to a
stateless `/v1/systemone` endpoint. Ratel Cloud owns the catalog instead, and ranking goes
through the documented [Tool Picker API](https://docs.ratel.sh/cloud/tool-picker). The first
draft's invented Ratel `/v1/systemone` endpoint was dropped before release.

Revised again 2026-10-02: Jev support in the SDK is kept beside the picker (decision 7). The
`systemOne` method and reranker call Jev directly, for catalogs the SDK owns; `cloud` serves
catalogs Cloud owns. Both reach the same model.

Builds on [ADR-0011](0011-selectable-retrieval-methods.md) (selectable methods; its "no
cross-encoder reranker" is lifted here), [ADR-0014](0014-adaptive-usage-ranking.md) (the usage
arm) and [ADR-0027](0027-cloud-catalog-sync.md) (how the catalog reaches Cloud).

## Context

Every ranker Ratel ships scores a query against tool text it holds in-process: BM25, dense
cosine, or the two fused. Nothing reorders their output; the only re-ranking is the usage arm.

Hosted "system-one" models pick the correct option for a query from a closed set in a few hundred
milliseconds. Jev (TypeSafe AI) returns a probability per option for up to 255 options; a probe
against a 4-tool payments catalog picked the refund tool BM25 ranked sixth, at 0.93, in 0.3 s.
OpenAI's Decisions API is in limited preview with no public docs and, as described, returns a
single pick.

Ratel Cloud exposes this as the Tool Picker, `POST https://cloud.ratel.sh/v1/tools/pick`:

- request `{ query, mode?, top_k? }` (`top_k` 1–20, default 5), bearer `RATEL_API_KEY`;
- response `{ mode, tools: [{ id, name, description, score }], confident, usage }`;
- three modes:

  | Mode | Pipeline | Latency | Cost |
  |---|---|---|---|
  | `instant` | BM25 | milliseconds | free |
  | `precise` (default) | BM25 shortlist, Jev reranks, top `k` | ~300 ms | per token |
  | `exhaustive` | Jev over the whole catalog, as a tournament (up to 2,000 tools) | 1–few s | per token |

  Per the Cloud implementation (`ratel-cloud`, `lib/pick/engine.ts`): a catalog that fits one Jev
  question (≤ 150 tools) goes to Jev whole in both judged modes; above that `precise` shortlists
  the BM25 top 25 (the public docs say 30) and `exhaustive` runs groups that fit one question and
  advances the winners. `confident` is Jev's confidence ≥ 0.8.

- errors `400`, `401`, `402` (credits), `409` (no synced tools), `429` (`Retry-After`), `502`/`503`,
  `504` (> 45 s).

The request carries no tools. The picker ranks the project's runtime catalog (`kind = 'tool'`
rows), filled by `PUT /api/v1/catalog/snapshot`, so the catalog's owner is Cloud, and an SDK that
wants these modes must keep that catalog in sync ([ADR-0027](0027-cloud-catalog-sync.md)).

## Decision

**1. Cloud owns the catalog; the SDK calls the Tool Picker.** A catalog (and `ratel()`) takes one
option:

```ts
cloud: { mode: "instant" | "precise" | "exhaustive", url?, apiKeyEnv? }
```

`url` defaults to `https://cloud.ratel.sh`, `apiKeyEnv` to `RATEL_API_KEY`. Setting `cloud`
turns on catalog sync ([ADR-0027](0027-cloud-catalog-sync.md)) and routes tool searches to
`/v1/tools/pick` with that mode. `searchAsync(q, k, { mode })` overrides the mode per call.
`cloud` together with `method` or `reranker` is a configuration error: the mode picks the
pipeline. Python spells it `cloud={"mode": ..., "url": ..., "api_key_env": ...}`.

**2. Every mode goes to Cloud, `instant` included.** A local BM25 would be faster, but only
correct while the local and synced catalogs agree; one source of truth for every mode is worth a
network hop. Synchronous `search()` therefore throws on a cloud catalog.

**3. Execution stays local.** The picker returns ids; `invoke` runs the locally registered
executor with the local schema. A returned id that is not registered locally is dropped and
warned about — it means the synced catalog is ahead of or apart from this process.

**4. The Ratel SDK owns the client, not `@ratel-ai/cloud-sdk`.** One option in one package, in
both TypeScript and Python (cloud-sdk is TypeScript-only), and picking cannot be switched on
without the sync it depends on. One Rust `CloudClient` in core, shared by the picker and sync and
used by both SDKs, carries auth (key read at call time), timeouts (15 s; 60 s for `exhaustive`, above the
server's 45 s), response validation (unknown and repeated ids dropped, scores clamped to `[0, 1]`,
at most `top_k`) and typed errors:

| Status | `CloudError` code |
|---|---|
| 401 / 403 | `Unauthorized` |
| 402 | `InsufficientCredits` |
| 409 | `NoSyncedTools` |
| 429 | `RateLimited` (carries `retryAfter`) |
| 504 / transport timeout | `Timeout` |
| 502 / 503 / unreachable | `Unavailable` |
| bad body | `Malformed` |

`top_k` above 20 is clamped to 20, because the capability tools may ask for more. Hits keep the
`SearchHit` shape (`score` from the picker, `fused: false`); `confident` and `usage` ride the
search trace stage. A failed pick throws; an opt-in `fallback: "local-bm25"` serves local BM25
for hosts that prefer a degraded answer to none.

**5. Tools only, for now.** The picker ranks tools. Skills and facts are searched locally; they
sync once Cloud's snapshot accepts them, and use the picker once it takes a `kind`
([ADR-0027](0027-cloud-catalog-sync.md)).

**6. The two-stage reranker stays.** Independent of Cloud, a catalog may set
`reranker: { method, depth = 50 }` to re-score its first stage's top `depth` with any method
(`bm25`, `semantic`, `hybrid`, `systemOne`) other than its own. It never adds a candidate; its score
replaces stage 1's, ties keep stage 1's order; BM25 as a reranker keeps corpus-wide IDF; the
usage arm applies to stage 1 only; one search event carries stage 1's stages plus `rerank`.
Core exposes it as `search_with_options(query, top_k, origin, SearchOptions)` returning
`SearchError`, beside the unchanged `search_with_method*`.

**7. Jev, called directly, for catalogs the SDK owns.** `method: "systemOne"` (Jev ranks the
whole catalog) and `reranker: { method: "systemOne" }` (Jev re-scores the first stage's
candidates) call Jev's `POST /v1/systemone` from the SDK, configured by
`systemOne: { url?, apiKeyEnv?, model? }` — defaults `https://api.typesafe.ai`,
`TYPESAFE_API_KEY`, `jev-latest`. Core asks one `choice` question with the candidates' searchable
text as index-keyed criteria (`t0…tN`) and ranks by the returned probabilities. A candidate set
over 150 options or 80,000 characters — Cloud's per-question limits — runs as a tournament:
groups that fit one question are ranked in parallel (6 at a time), each keeps its top `k`, and
the winners go to a final round. A failed `systemOne` reranker returns stage 1's order and
records a `rerank_fallback` stage; a failed standalone search raises a typed `SystemOneError`.
`systemOne` and `cloud` on one catalog is a configuration error; facts do not support it.

**Not in this decision:** conversation context as picker input, skill and fact picking, and
OpenAI Decisions as a provider — all server-side concerns behind the same endpoint.

## Consequences

- **Data leaves the process.** A cloud catalog uploads tool, skill and fact definitions and sends
  every query to Ratel Cloud, which forwards text to the model provider. Local methods never
  leave the process. The SDK READMEs say so in bold.
- A search costs a network round trip in every mode and tokens in `precise` / `exhaustive`; free
  plans allow 10 `precise` / `exhaustive` picks a minute.
- Providers, the BM25 prefilter depth and chunking for large catalogs live in Cloud: changing them
  needs no SDK release, and the SDK cannot tune them.
- Correctness depends on sync: a search can only find what Cloud has. ADR-0027 makes `register`
  resolve after Cloud acknowledges the catalog, and the dropped-id warning surfaces drift.
- Two routes reach Jev: Cloud's picker (Cloud's key, Cloud's credits, Cloud-owned catalog) and
  `systemOne` (the user's TypeSafe key, an SDK-owned catalog). The tournament limits match
  Cloud's so the two rank alike; a change to one should be mirrored in the other.
- `@ratel-ai/cloud-sdk`'s `attach()` also publishes catalog snapshots. A host using both uploads
  the same snapshot twice under the same `source_id` — harmless, but the docs say to use one.

## Rejected

- **A Ratel-hosted stateless `/v1/systemone` endpoint** (this ADR's first draft): the SDK sends
  candidates and Ratel forwards them to a provider. The documented picker ranks a synced catalog
  instead, and the SDK-owned case is served by calling Jev directly (decision 7).
- **Generic provider config on the catalog** (`{ jev: {...}, openai: {...} }`). `systemOne`
  targets Jev only; further providers go behind Cloud's picker, which needs no SDK release.
- **Local BM25 for `instant`.** Faster, but a second source of truth.
- **The picker client in `@ratel-ai/cloud-sdk`** behind a core seam (the ADR-0022 pattern). It
  avoids a second snapshot publisher, but leaves Python without the picker until a Python cloud
  package exists, and splits one feature across two packages.
