// The Jev plugin (ADR-0027): Jev (TypeSafe AI) wrapped into the ranking
// functions a catalog takes, `retrieveFn` and `rerankerFn`. Search knows only
// those functions; Jev's request format lives in the native Jev client, so a
// change to Jev's interface never reaches the catalogs.

import { JevRanker } from "../native/index.cjs";
import type { RankFn } from "./catalog.js";
import { mapRetrieverError } from "./errors.js";

/** Where the Jev plugin sends requests. */
export interface JevPluginConfig {
  /** Jev base URL (a proxy, tests); `/v1/systemone` is appended. Default `https://api.typesafe.ai`. */
  url?: string;
  /** Name of the environment variable holding the Jev key, read at call time. Default `TYPESAFE_API_KEY`. */
  apiKeyEnv?: string;
  /** Jev model. Default `"jev-latest"`. */
  model?: string;
}

/** A model's two ranking functions, for `retrieveFn` and `rerankerFn`. */
export interface RetrieverPlugin {
  /** Rank the whole catalog: pass as `retrieveFn` with `method: "custom"`. */
  retrieve: RankFn;
  /** Rerank the first stage's top candidates: pass as `rerankerFn`. */
  rerank: RankFn;
}

/**
 * Jev as a ranker or reranker (ADR-0027). The query and each candidate's
 * searchable text are sent to Jev; every failure throws a
 * {@link RetrieverError} whose `transient` flag decides whether a reranker
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
  const ranker = new JevRanker(config);
  const rank: RankFn = async (query, candidates, topK) => {
    if (candidates.length === 0 || topK <= 0) return [];
    const kind = candidates[0]?.kind ?? "tool";
    try {
      return await ranker.rankAsync(
        query,
        candidates.map(({ id, text }) => ({ id, text })),
        topK,
        kind,
      );
    } catch (error) {
      throw mapRetrieverError(error);
    }
  };
  return { retrieve: rank, rerank: rank };
}
