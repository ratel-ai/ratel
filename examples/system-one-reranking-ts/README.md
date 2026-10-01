# `examples/system-one-reranking-ts` — system-one ranking and the two-stage reranker

Shows [ADR-0026](../../docs/adr/0026-system-one-ranking-and-reranker.md) end to end. A support agent's catalog asks for a refund, and BM25 confidently picks the wrong tool. The example then shows the two ways to fix that with a system-one model:

- **As a reranker:** BM25 retrieves candidates and `"systemOne"` reorders them.
- **On its own:** `method: "systemOne"` ranks the whole catalog.

**No API key needed.** The example starts a local stand-in for Ratel Cloud's `/v1/systemone` that speaks the real wire contract. Its "model" is a hard-coded intent table, so it shows the plumbing, not ranking quality. The Python mirror is [`examples/system-one-reranking-python`](../system-one-reranking-python/README.md).

## Setup

```bash
pnpm install
pnpm -F @ratel-ai/example-system-one-reranking start
```

Expected output (the port varies):

```
system-one endpoint: http://127.0.0.1:63695/v1/systemone  (local stand-in)

query: "the customer was charged twice, give them their money back"

bm25               : stripe_list_charges (1.74) > stripe_create_charge (1.71) > stripe_create_customer (0.27)
  (bm25 ranks stripe_refund_payment #6)
bm25 -> systemOne  : stripe_refund_payment (0.95) > stripe_list_charges (0.01) > stripe_create_charge (0.01)
  reranker: null   : stripe_list_charges (1.74) > stripe_create_charge (1.71) > stripe_create_customer (0.27)
systemOne alone    : stripe_refund_payment (0.95) > stripe_create_charge (0.01) > stripe_list_charges (0.01)

endpoint down:
  as a reranker    : stripe_list_charges (1.74) > stripe_create_charge (1.71) > stripe_create_customer (0.27)   (BM25 order)
  standalone       : SystemOneError code=Unreachable

stand-in endpoint served 2 requests
```

BM25 ranks the refund tool sixth because the query's strongest term is *charged*. The reranker brings it to the top from BM25's first 20 candidates (`depth: 20`). It could not if BM25 had not retrieved it at all, because a reranker never adds tools.

## Using a real endpoint

```bash
RATEL_SYSTEM_ONE_URL=https://app.ratel.sh/v1/systemone RATEL_API_KEY=... \
  pnpm -F @ratel-ai/example-system-one-reranking start
```

**`"systemOne"` sends the query and every candidate's searchable text to that endpoint**, which forwards them to the model provider. BM25, semantic and hybrid never leave the process.

## Layout

```
src/tools.ts            the payments catalog, the query, a hit printer
src/mock-system-one.ts  local stand-in for POST /v1/systemone (real wire contract, toy model)
src/index.ts            entry — bm25, bm25 -> systemOne, systemOne alone, failure behaviour
```

## The options it uses

- `reranker: { method, depth }`: a second stage over the first stage's top `depth` candidates (default 50). Its method can be `"bm25"`, `"semantic"`, `"hybrid"` or `"systemOne"`, as long as it differs from the first stage's method. A semantic or hybrid reranker makes `register()` build embeddings, which needs an embedding model.
- `method: "systemOne"`: the system-one model is the only stage and ranks every tool.
- `systemOne: { url, apiKeyEnv }`: where system-one calls go. It defaults to Ratel Cloud with `RATEL_API_KEY`.
- `searchAsync(q, k, { reranker: null })`: turns the catalog's reranker off for one call. Rerankers and `"systemOne"` only work with `searchAsync`; synchronous `search` throws.
- **Failure:** a failed system-one *reranker* returns the first stage's order (and records a `rerank_fallback` trace stage). A failed standalone `"systemOne"` search throws `SystemOneError` with a stable `.code`.
