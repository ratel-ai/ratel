# `examples/system-one-reranking-ts` — Jev as a system-one ranker, called directly

This example shows the SDK-side system-one path of [ADR-0027](../../docs/adr/0027-system-one-ranking-and-reranker.md). The catalog lives in your process, and `"systemOne"` sends the query and candidates straight to [Jev](https://docs.typesafe.ai) (TypeSafe AI). On a refund request, BM25 confidently picks the wrong tool. Jev fixes it in one of two ways:

- **As a reranker:** BM25 retrieves candidates and `"systemOne"` reorders them.
- **On its own:** `method: "systemOne"` ranks the whole catalog.

**Running it:**
- **With `TYPESAFE_API_KEY` set,** it calls Jev.
- **Without the key,** it runs against `src/local-jev.ts`, a local stand-in that speaks Jev's wire format. Its judge is a hard-coded intent table, so it shows the plumbing, not ranking quality.

For a catalog Ratel Cloud owns, which Cloud ranks with Jev behind its Tool Picker, see [`examples/cloud-tool-picker-ts`](../cloud-tool-picker-ts/README.md). The Python mirror is [`examples/system-one-reranking-python`](../system-one-reranking-python/README.md).

## Run

```bash
pnpm install
TYPESAFE_API_KEY=... pnpm -F @ratel-ai/example-system-one-reranking start   # omit the key for the stand-in
```

Output against Jev (`jev-1.13.0`):

```
jev: https://api.typesafe.ai

query: "the customer was charged twice, give them their money back"

bm25               : stripe_list_charges (1.74) > stripe_create_charge (1.71) > stripe_create_customer (0.27)
  (bm25 ranks stripe_refund_payment #6)
bm25 -> systemOne  : stripe_refund_payment (0.93) > stripe_list_charges (0.07) > stripe_create_charge (0.00)
  reranker: null   : stripe_list_charges (1.74) > stripe_create_charge (1.71) > stripe_create_customer (0.27)
systemOne alone    : stripe_refund_payment (0.93) > stripe_list_charges (0.07) > stripe_create_charge (0.00)

jev down:
  as a reranker    : stripe_list_charges (1.74) > stripe_create_charge (1.71) > stripe_create_customer (0.27)   (BM25 order)
  standalone       : SystemOneError code=Unreachable
```

BM25 ranks the refund tool sixth because the query's strongest term is *charged*. Jev brings it to the top from BM25's first 20 candidates (`depth: 20`). A reranker never adds tools, so it could not do this if BM25 hadn't retrieved the tool at all.

**`"systemOne"` sends the query and every candidate's searchable text (name, description, schema terms) to Jev.** BM25, semantic and hybrid never leave the process.

## Layout

```
src/tools.ts      the payments catalog, the query, a hit printer
src/local-jev.ts  local stand-in for Jev's POST /v1/systemone (real wire format, toy judge)
src/index.ts      entry — bm25, bm25 -> systemOne, systemOne alone, failure behaviour
```

## The options it uses

- `reranker: { method, depth }` is a second stage over the first stage's top `depth` candidates (default 50). Its method can be `"bm25"`, `"semantic"`, `"hybrid"` or `"systemOne"`, but not the first stage's own method.
- `method: "systemOne"` makes Jev the only stage. Above 150 tools, the candidates are split into groups, and each group's winners go into a final round.
- `systemOne: { url, apiKeyEnv, model }` sets where calls go. The defaults are `https://api.typesafe.ai`, `TYPESAFE_API_KEY` and `jev-latest`.
- `searchAsync(q, k, { reranker: null })` turns the catalog's reranker off for one call. Synchronous `search` throws on `"systemOne"` and on any catalog with a reranker.
- **Failure:** a failed standalone `"systemOne"` search throws `SystemOneError` with a stable `.code`. A system-one *reranker* throws only misconfiguration (`"Config"`, `"Unauthorized"`, `"InvalidRequest"`); on any other failure, like the unreachable Jev above, it returns the first stage's order and records a `rerank_fallback:<code>` trace stage.
