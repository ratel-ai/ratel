# `examples/openai-decision-retriever-ts` — OpenAI's Decisions API as a retriever and reranker

This example shows [ADR-0027](../../docs/adr/0027-custom-retriever-and-reranker-functions.md) with OpenAI's [Decisions API](https://developers.openai.com/api/docs/guides/decisions). `ratelOpenAIDecisionPlugin()` wraps it into the two ranking functions a catalog takes. On a refund request, BM25 confidently picks the wrong tool. Decisions fixes it in one of two ways:

- **As a reranker:** BM25 retrieves candidates and `rerankerFn: decision.rerank` reorders them.
- **On its own:** `method: "custom"` with `retrieveFn: decision.retrieve` ranks the whole catalog.

**The Decisions API is in public beta, so the plugin is too.** Making the first plugin prints a one-time warning. Set `RATEL_EXPERIMENTAL_SILENCE=1` to silence it.

**Running it:**
- **With `OPENAI_API_KEY` set,** it calls OpenAI (the key needs Decisions access).
- **Without the key,** it runs against `src/local-openai-decision.ts`, a local stand-in that speaks the Decisions wire format. Its judge is a hard-coded intent table, so it shows the plumbing, not ranking quality.

The Python mirror is [`examples/openai-decision-retriever-python`](../openai-decision-retriever-python/README.md). The Jev version is [`examples/jev-retriever-ts`](../jev-retriever-ts/README.md).

## Run

```bash
pnpm install
OPENAI_API_KEY=... pnpm -F @ratel-ai/example-openai-decision-retriever start   # omit the key for the stand-in
```

Output against the local stand-in:

```
ratel: the OpenAI Decisions plugin is beta. OpenAI's Decisions API is in public beta and may change; only gpt-6-luna is supported. ...

decisions: http://127.0.0.1:58747  (local stand-in)

query: "the customer was charged twice, give them their money back"

bm25                : stripe_list_charges (1.74) > stripe_create_charge (1.71) > stripe_create_customer (0.27)
  (bm25 ranks stripe_refund_payment #6)
bm25 -> decisions   : stripe_refund_payment (0.95) > stripe_list_charges (0.01) > stripe_create_charge (0.01)
decisions alone     : stripe_refund_payment (0.94) > stripe_create_charge (0.01) > stripe_list_charges (0.01)

decisions down:
  as a reranker     : stripe_list_charges (1.74) > stripe_create_charge (1.71) > stripe_create_customer (0.27)   (BM25 order)
  as the retriever  : RetrieverError code=Unreachable transient=true
```

**The plugin sends the query and every candidate's searchable text (name, description, schema terms) to OpenAI.** BM25, semantic and hybrid never leave the process.

## Layout

```
src/tools.ts                  the payments catalog, the query, a hit printer
src/local-openai-decision.ts  local stand-in for POST /v1/decisions (real wire format, toy judge)
src/index.ts                  entry — bm25, bm25 -> decisions, decisions alone, failure behaviour
```

## The options it uses

- `ratelOpenAIDecisionPlugin({ url?, apiKeyEnv?, model? })` returns `{ retrieve, rerank }`. The defaults are `https://api.openai.com`, `OPENAI_API_KEY` and `gpt-6-luna`, the only model the beta supports.
- It asks one `choice` question per call. OpenAI documents no limits, so it uses Jev's: above 150 candidates (or 80,000 characters) it judges groups in parallel and a final round of their winners.
- Tools and skills only: facts aren't ranked by the hooks yet. Text only: no images are sent.
- **Failure:** a transient `RetrieverError` from `rerankerFn` keeps the first stage's order and records a `rerank_fallback:<code>` trace stage. That includes `code: "Refused"`, when the model declines to answer. Anything else, and any `retrieveFn` failure, throws.
