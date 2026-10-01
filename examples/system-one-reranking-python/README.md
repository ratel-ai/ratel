# `examples/system-one-reranking-python` — system-one ranking and the two-stage reranker

The Python mirror of [`examples/system-one-reranking-ts`](../system-one-reranking-ts/README.md); see that README for the full walkthrough. It shows [ADR-0026](../../docs/adr/0026-system-one-ranking-and-reranker.md) on a payments catalog where BM25 picks the wrong tool for a refund request:

- **As a reranker:** BM25 retrieves candidates and `"systemOne"` reorders them.
- **On its own:** `method="systemOne"` ranks the whole catalog.

**No API key needed.** `mock_system_one.py` is a local stand-in for Ratel Cloud's `/v1/systemone` that speaks the real wire contract; its "model" is a hard-coded intent table, so it shows the plumbing, not ranking quality.

## Run

```bash
uv run main.py
```

Expected output (the port varies):

```
system-one endpoint: http://127.0.0.1:63740/v1/systemone  (local stand-in)

query: "the customer was charged twice, give them their money back"

bm25               : stripe_list_charges (1.74) > stripe_create_charge (1.71) > stripe_create_customer (0.27)
  (bm25 ranks stripe_refund_payment #6)
bm25 -> systemOne  : stripe_refund_payment (0.95) > stripe_list_charges (0.01) > stripe_create_charge (0.01)
  reranker=False   : stripe_list_charges (1.74) > stripe_create_charge (1.71) > stripe_create_customer (0.27)
systemOne alone    : stripe_refund_payment (0.95) > stripe_create_charge (0.01) > stripe_list_charges (0.01)

endpoint down:
  as a reranker    : stripe_list_charges (1.74) > stripe_create_charge (1.71) > stripe_create_customer (0.27)   (BM25 order)
  standalone       : SystemOneError code=Unreachable

stand-in endpoint served 2 requests
```

To call a real endpoint, set `RATEL_SYSTEM_ONE_URL` and `RATEL_API_KEY`. **`"systemOne"` sends the query and every candidate's searchable text to that endpoint**, which forwards them to the model provider.

## Layout

```
tools.py            the payments catalog, the query, a hit printer
mock_system_one.py  local stand-in for POST /v1/systemone (real wire contract, toy model)
main.py             entry — bm25, bm25 -> systemOne, systemOne alone, failure behaviour
```

## The Python spelling

- `ToolCatalog(reranker={"method": "systemOne", "depth": 20}, system_one={"url": ..., "api_key_env": ...})`
- `await catalog.search_async(q, k, reranker=False)` turns the catalog's reranker off for one call; passing a `RerankerConfig` replaces it.
- A failed standalone search raises `SystemOneError` (a `RuntimeError`) with `.code` and `.status`; a failed reranker falls back to BM25's order.
