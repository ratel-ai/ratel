# `examples/jev-retriever-ts` — Jev as a retriever and reranker

This example shows [ADR-0027](../../docs/adr/0027-custom-retriever-and-reranker-functions.md) end to end. A catalog ranks with functions it is given, and `ratelJevPlugin()` wraps [Jev](https://docs.typesafe.ai) (TypeSafe AI) into two of them. On a refund request, BM25 confidently picks the wrong tool. Jev fixes it in one of two ways:

- **As a reranker:** BM25 retrieves candidates and `rerankerFn: jev.rerank` reorders them.
- **On its own:** `method: "custom"` with `retrieveFn: jev.retrieve` ranks the whole catalog.

It also plugs in a plain function of its own, to show the hooks take any model.

**Running it:**
- **With `TYPESAFE_API_KEY` set,** it calls Jev.
- **Without the key,** it runs against `src/local-jev.ts`, a local stand-in that speaks Jev's wire format. Its judge is a hard-coded intent table, so it shows the plumbing, not ranking quality.

The Python mirror is [`examples/jev-retriever-python`](../jev-retriever-python/README.md).

## Run

```bash
pnpm install
TYPESAFE_API_KEY=... pnpm -F @ratel-ai/example-jev-retriever start   # omit the key for the stand-in
```

Output against Jev (`jev-latest`; Jev's probabilities vary slightly from run to run):

```
jev: https://api.typesafe.ai

query: "the customer was charged twice, give them their money back"

bm25                : stripe_list_charges (1.74) > stripe_create_charge (1.71) > stripe_create_customer (0.27)
  (bm25 ranks stripe_refund_payment #6)
bm25 -> jev         : stripe_refund_payment (0.86) > stripe_list_charges (0.14) > stripe_create_charge (0.00)
  reranker: null    : stripe_list_charges (1.74) > stripe_create_charge (1.71) > stripe_create_customer (0.27)
jev alone           : stripe_refund_payment (0.87) > stripe_list_charges (0.13) > stripe_create_charge (0.00)
bm25 -> your fn     : stripe_refund_payment (1.00) > stripe_list_charges (0.00) > stripe_create_charge (0.00)

jev down:
  as a reranker     : stripe_list_charges (1.74) > stripe_create_charge (1.71) > stripe_create_customer (0.27)   (BM25 order)
  as the retriever  : RetrieverError code=Unreachable transient=true
```

BM25 ranks the refund tool sixth because the query's strongest term is *charged*. Jev brings it to the top from BM25's first 20 candidates (`rerankerDepth: 20`). A reranker never adds tools, so it could not do this if BM25 hadn't retrieved the tool at all.

**The Jev plugin sends the query and every candidate's searchable text (name, description, schema terms) to Jev.** BM25, semantic and hybrid never leave the process.

## Layout

```
src/tools.ts      the payments catalog, the query, a hit printer
src/local-jev.ts  local stand-in for Jev's POST /v1/systemone (real wire format, toy judge)
src/index.ts      entry — bm25, bm25 -> jev, jev alone, your own function, failure behaviour
```

## The options it uses

- `ratelJevPlugin({ url?, apiKeyEnv?, model? })` returns `{ retrieve, rerank }`. The defaults are `https://api.typesafe.ai`, `TYPESAFE_API_KEY` and `jev-latest`. Above 150 candidates it judges groups and a final round of their winners.
- `rerankerFn` reranks the first stage's top `rerankerDepth` candidates (default 50). `method: "custom"` with `retrieveFn` makes the function the only stage.
- Any `(query, candidates, topK) => { id, score }[]` works in either place.
- `searchAsync(q, k, { reranker: null })` turns the catalog's reranker off for one call. Synchronous `search` throws on `"custom"` and on any catalog with a reranker.
- **Failure:** a `rerankerFn` that throws a `RetrieverError` with `transient: true`, like the unreachable Jev above, keeps the first stage's order and records a `rerank_fallback:<code>` trace stage. Anything else, and any `retrieveFn` failure, throws.
