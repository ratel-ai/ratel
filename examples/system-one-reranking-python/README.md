# `examples/system-one-reranking-python` — Jev as a system-one ranker, called directly

The Python mirror of [`examples/system-one-reranking-ts`](../system-one-reranking-ts/README.md); see that README for the walkthrough ([ADR-0026](../../docs/adr/0026-system-one-ranking-and-reranker.md)). The catalog lives in your process, and `"systemOne"` sends the query and candidates straight to [Jev](https://docs.typesafe.ai), either as a reranker over BM25 or as the only stage.

With `TYPESAFE_API_KEY` set it calls Jev. Without it, it runs against `local_jev.py`, a local stand-in that speaks Jev's wire format and judges with a toy intent table. For a catalog Ratel Cloud owns, see [`examples/cloud-tool-picker-python`](../cloud-tool-picker-python/README.md).

## Run

```bash
TYPESAFE_API_KEY=... uv run main.py   # omit the key for the stand-in
```

Output against Jev:

```
bm25               : stripe_list_charges (1.74) > stripe_create_charge (1.71) > stripe_create_customer (0.27)
  (bm25 ranks stripe_refund_payment #6)
bm25 -> systemOne  : stripe_refund_payment (0.92) > stripe_list_charges (0.08) > stripe_create_charge (0.00)
  reranker=False   : stripe_list_charges (1.74) > stripe_create_charge (1.71) > stripe_create_customer (0.27)
systemOne alone    : stripe_refund_payment (0.95) > stripe_list_charges (0.05) > stripe_create_charge (0.00)

jev down:
  as a reranker    : stripe_list_charges (1.74) > stripe_create_charge (1.71) > stripe_create_customer (0.27)   (BM25 order)
  standalone       : SystemOneError code=Unreachable
```

**`"systemOne"` sends the query and every candidate's searchable text to Jev.**

## The Python spelling

- `ToolCatalog(reranker={"method": "systemOne", "depth": 20}, system_one={"url": ..., "api_key_env": ..., "model": ...})`
- `await catalog.search_async(q, k, reranker=False)` turns the catalog's reranker off for one call.
- A failed standalone search raises `SystemOneError` (a `RuntimeError`) with `.code` and `.status`. A failed reranker falls back to BM25's order.
