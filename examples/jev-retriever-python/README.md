# `examples/jev-retriever-python` — Jev as a retriever and reranker

The Python mirror of [`examples/jev-retriever-ts`](../jev-retriever-ts/README.md); see that README for the walkthrough ([ADR-0027](../../docs/adr/0027-custom-retriever-and-reranker-functions.md)). `ratel_jev_plugin()` wraps [Jev](https://docs.typesafe.ai) into `retrieve` and `rerank` functions, used either as a reranker over BM25 or as the only stage, next to a plain function of the example's own.

With `TYPESAFE_API_KEY` set it calls Jev. Without it, it runs against `local_jev.py`, a local stand-in that speaks Jev's wire format and judges with a toy intent table.

## Run

```bash
TYPESAFE_API_KEY=... uv run main.py   # omit the key for the stand-in
```

Output against Jev (`jev-latest`; Jev's probabilities vary slightly from run to run):

```
jev: https://api.typesafe.ai

query: "the customer was charged twice, give them their money back"

bm25                : stripe_list_charges (1.74) > stripe_create_charge (1.71) > stripe_create_customer (0.27)
  (bm25 ranks stripe_refund_payment #6)
bm25 -> jev         : stripe_refund_payment (0.86) > stripe_list_charges (0.14) > stripe_create_charge (0.00)
  reranker=False    : stripe_list_charges (1.74) > stripe_create_charge (1.71) > stripe_create_customer (0.27)
jev alone           : stripe_refund_payment (0.86) > stripe_list_charges (0.14)
bm25 -> your fn     : stripe_refund_payment (1.00) > stripe_list_charges (0.00) > stripe_create_charge (0.00)

jev down:
  as a reranker     : stripe_list_charges (1.74) > stripe_create_charge (1.71) > stripe_create_customer (0.27)   (BM25 order)
  as the retriever  : RetrieverError code=Unreachable transient=True
```

**The Jev plugin sends the query and every candidate's searchable text to Jev.**

## The Python spelling

- `ToolCatalog(reranker_fn=jev.rerank, reranker_depth=20)` and `ToolCatalog(method="custom", retrieve_fn=jev.retrieve)`.
- `ratel_jev_plugin(url=None, api_key_env=None, model=None)`; the plugin calls Jev on a worker thread.
- A ranking function may be sync or async and returns a list of `{"id", "score"}`.
- `await catalog.search_async(q, k, reranker=False)` turns the catalog's reranker off for one call.
- A failure raises `RetrieverError` (a `RuntimeError`) with `.code`, `.transient`, `.status` and `.retry_after_secs`. As a reranker, a transient one falls back to BM25's order instead.
