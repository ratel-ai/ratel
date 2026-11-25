# `lib/adapters` (L0)

`oss/`: the open-source implementation of every port in `lib/contracts`. One file per port, no
I/O beyond logging and environment reads. The Cloud implementations live in the private checkout
at `ee/src`, never here.

`oss/embedding-provider.ts` reads its own variables (ADR-0009); a refused call carries its `status` for the model status: `EMBEDDING_BASE_URL` (any server
that speaks `/embeddings`; alone, a server that asks for no key), `EMBEDDING_API_KEY` and
`EMBEDDING_MODEL`. Without the first two it follows `OPENAI_API_KEY` as before. The OpenAI key and
`OPENAI_BASE_URL` are never used with `EMBEDDING_BASE_URL`, so decisions and embeddings can sit on
different servers. Without any of them it is the local hashing vectorizer, and nothing calls out.
