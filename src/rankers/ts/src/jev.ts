// The Jev plugin (ADR-0027, ADR-0028): Jev (TypeSafe AI) wrapped into the
// ranking functions a catalog takes, `retrieveFn` and `rerankerFn`. Search
// knows only those functions; Jev's request format lives in the native
// ranker, so a change to Jev's interface never reaches the SDK.

import type { RetrieverPlugin } from "@ratel-ai/sdk";
import { choiceRankerPlugin, nativeRanker } from "./adapter.js";

/** Where the Jev plugin sends requests. */
export interface JevPluginConfig {
  /** Jev base URL (a proxy, tests); `/v1/systemone` is appended. Default `https://api.typesafe.ai`. */
  url?: string;
  /** Name of the environment variable holding the Jev key, read at call time. Default `TYPESAFE_API_KEY`. */
  apiKeyEnv?: string;
  /** Jev model. Default `"jev-latest"`. */
  model?: string;
}

/**
 * Jev as a ranker or reranker (ADR-0027). The query and each candidate's
 * searchable text are sent to Jev; every failure throws a
 * `RetrieverError` whose `transient` flag decides whether a reranker
 * falls back to the first stage's order.
 *
 * **Experimental** — may change without a major version bump.
 *
 * @example
 * ```ts
 * const jev = ratelJevPlugin({ apiKeyEnv: "TYPESAFE_API_KEY" });
 * ratel({ method: "custom", retrieveFn: jev.retrieve });   // Jev ranks every tool
 * ratel({ method: "bm25", rerankerFn: jev.rerank });       // Jev reranks BM25's top 50
 * ```
 */
export function ratelJevPlugin(config: JevPluginConfig = {}): RetrieverPlugin {
  return choiceRankerPlugin(nativeRanker("jev", config));
}
