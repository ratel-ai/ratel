# `examples/openai-decision-retriever-python` — OpenAI's Decisions API as a retriever and reranker

The Python mirror of [`examples/openai-decision-retriever-ts`](../openai-decision-retriever-ts/README.md); see that README for the walkthrough ([ADR-0027](../../docs/adr/0027-custom-retriever-and-reranker-functions.md)). `ratel_openai_decision_plugin()` wraps OpenAI's [Decisions API](https://developers.openai.com/api/docs/guides/decisions) into `retrieve` and `rerank` functions, used either as a reranker over BM25 or as the only stage.

**The Decisions API is in public beta, so the plugin is too.** The first plugin made emits a one-time `ExperimentalWarning`. Set `RATEL_EXPERIMENTAL_SILENCE=1` to silence it.

With `OPENAI_API_KEY` set it calls OpenAI. Without it, it runs against `local_openai_decision.py`, a local stand-in that speaks the Decisions wire format and judges with a toy intent table.

## Run

```bash
OPENAI_API_KEY=... uv run main.py   # omit the key for the stand-in
```

Output against the local stand-in (after the warning):

```
decisions: http://127.0.0.1:58775  (local stand-in)

query: "the customer was charged twice, give them their money back"

bm25                : stripe_list_charges (1.74) > stripe_create_charge (1.71) > stripe_create_customer (0.27)
  (bm25 ranks stripe_refund_payment #6)
bm25 -> decisions   : stripe_refund_payment (0.95) > stripe_list_charges (0.01) > stripe_create_charge (0.01)
decisions alone     : stripe_refund_payment (0.94) > stripe_create_charge (0.01) > stripe_list_charges (0.01)

decisions down:
  as a reranker     : stripe_list_charges (1.74) > stripe_create_charge (1.71) > stripe_create_customer (0.27)   (BM25 order)
  as the retriever  : RetrieverError code=Unreachable transient=True
```

**The plugin sends the query and every candidate's searchable text to OpenAI.**

## The Python spelling

- `ToolCatalog(reranker_fn=decision.rerank, reranker_depth=20)` and `ToolCatalog(method="custom", retrieve_fn=decision.retrieve)`.
- `ratel_openai_decision_plugin(url=None, api_key_env=None, model=None)`; the plugin calls OpenAI on a worker thread.
- A failure raises `RetrieverError` with `.code`, `.transient`, `.status` and `.retry_after_secs`. As a reranker, a transient one (including `"Refused"`) falls back to BM25's order instead.
