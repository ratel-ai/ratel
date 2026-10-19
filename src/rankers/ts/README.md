# @ratel-ai/rankers-plugin

Decision-model rankers as retrieve/rerank plugins for [`@ratel-ai/sdk`](https://www.npmjs.com/package/@ratel-ai/sdk), the Ratel TypeScript SDK.

The SDK ranks through functions you give it (`retrieveFn`, `rerankerFn`; [ADR 0027](../../../docs/adr/0027-custom-retriever-and-reranker-functions.md)) and knows no vendor's API. This package holds the vendor clients, so the SDK stays vendor-free and a new vendor ships without an SDK release ([ADR 0028](../../../docs/adr/0028-vendor-rankers-as-plugin-packages.md)).

```bash
npm install @ratel-ai/sdk@rc @ratel-ai/rankers-plugin@rc
```

Keep the `@rc` on the SDK: this package needs `@ratel-ai/sdk` `0.13.0-rc.12` or later, npm's `latest` SDK is older until `0.13.0` ships, and npm does not check the version for you.

## Plugins

Each returns `{ retrieve, rerank }`:

- pass `retrieve` as `retrieveFn` with `method: "custom"`
- pass `rerank` as `rerankerFn`

Every failure throws the SDK's `RetrieverError`. When a reranker fails with `transient: true`, the search keeps the first stage's order.

```ts
import { ratel } from "@ratel-ai/sdk";
import { ratelJevPlugin, ratelOpenAIDecisionPlugin } from "@ratel-ai/rankers-plugin";

const jev = ratelJevPlugin();                                   // key in TYPESAFE_API_KEY
ratel({ method: "custom", retrieveFn: jev.retrieve });          // Jev ranks every tool and skill
ratel({ method: "bm25", rerankerFn: jev.rerank });              // BM25, then Jev over its top 50

const decision = ratelOpenAIDecisionPlugin();                  // key in OPENAI_API_KEY; public beta
ratel({ method: "bm25", rerankerFn: decision.rerank, rerankerDepth: 20 });
```

- **`ratelJevPlugin({ url?, apiKeyEnv?, model? })`:** Jev (TypeSafe AI).
  - Defaults: `https://api.typesafe.ai`, `TYPESAFE_API_KEY`, `jev-latest`.
- **`ratelOpenAIDecisionPlugin({ url?, apiKeyEnv?, model? })`:** OpenAI's Decisions API (public beta), for tools and skills, text only.
  - Defaults: `https://api.openai.com`, `OPENAI_API_KEY`, `gpt-6-luna`.
  - The first plugin made prints a one-time beta warning; set `RATEL_EXPERIMENTAL_SILENCE=1` to silence it.
- **Large catalogs:** above 150 candidates (or 80,000 characters), each plugin judges groups in parallel and puts the group winners into one final question.
- **Filtering:** picks below probability 0.01 are dropped, except the best one.
- **`RetrieverError.code`:**
  - not transient: `"Config"`, `"Unauthorized"`, `"InvalidRequest"`
  - transient: `"RateLimited"` (with `retryAfterSecs`), `"Overloaded"`, `"Timeout"`, `"Unreachable"`, `"Http"`, `"Malformed"`, `"Refused"` (OpenAI's model declined)
- **Privacy:** **the Jev plugin sends the query and each candidate's searchable text to TypeSafe AI. The OpenAI Decisions plugin sends them to OpenAI.**

## Writing your own plugin

The plugin contract belongs to the SDK. This package re-exports it, so a plugin can import everything from one place, and the types enforce the `RankFn` signature:

```ts
import { definePlugin, type RankFn } from "@ratel-ai/rankers-plugin";

const rank: RankFn = async (query, candidates, topK) => /* … */ [];
export const myPlugin = definePlugin({ retrieve: rank, rerank: rank });
```

`choiceRankerPlugin(ranker)` turns any object with `rankAsync(query, [{ id, text }], topK, kind)` into a plugin. It maps the native rankers' errors to `RetrieverError`.

## Layout

```
native/   NAPI-RS binding to the ratel-ai-rankers crate (../core)
npm/      the five per-platform binary packages, versioned with the loader
src/      the plugins, the shared adapter, the contract re-exports
```

## Build & test

```bash
pnpm --filter @ratel-ai/sdk build             # the SDK it peers on
pnpm --filter @ratel-ai/rankers-plugin test   # builds the native addon, then vitest
```

Released as the `rankers-ts-v*` unit (ADR-0008). The loader, the five platform packages and `native/` move together.
