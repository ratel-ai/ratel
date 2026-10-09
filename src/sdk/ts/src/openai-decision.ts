// The OpenAI Decisions plugin (ADR-0027): OpenAI's Decisions API wrapped into
// the ranking functions a catalog takes, `retrieveFn` and `rerankerFn`. Search
// knows only those functions; the Decisions request format lives in the native
// client, so a change to OpenAI's beta API never reaches the catalogs.

import { OpenAiDecisionRanker } from "../native/index.cjs";
import type { RankFn } from "./catalog.js";
import { mapRetrieverError } from "./errors.js";
import { warnOpenAIDecisionBetaOnce } from "./experimental-warning.js";
import type { RetrieverPlugin } from "./jev.js";

/** Where the OpenAI Decisions plugin sends requests. */
export interface OpenAIDecisionPluginConfig {
  /** Base URL (a proxy, tests); `/v1/decisions` is appended. Default `https://api.openai.com`. */
  url?: string;
  /** Name of the environment variable holding the OpenAI key, read at call time. Default `OPENAI_API_KEY`. */
  apiKeyEnv?: string;
  /** Decisions model. Default `"gpt-6-luna"`, the only one the beta supports. */
  model?: string;
}

/**
 * OpenAI's Decisions API as a ranker or reranker (ADR-0027), for tools and
 * skills. The query and each candidate's searchable text are sent to OpenAI;
 * every failure throws a {@link RetrieverError} whose `transient` flag decides
 * whether a reranker falls back to the first stage's order. A refusal by the
 * model is `code: "Refused"`, transient.
 *
 * The Decisions API is in public beta: making the first plugin prints a
 * one-time warning (silence it with `RATEL_EXPERIMENTAL_SILENCE=1`).
 *
 * **Experimental** — may change without a major version bump.
 *
 * @example
 * ```ts
 * const decision = ratelOpenAIDecisionPlugin();
 * ratel({ method: "custom", retrieveFn: decision.retrieve });          // Decisions ranks every tool
 * ratel({ method: "bm25", rerankerFn: decision.rerank, rerankerDepth: 20 }); // it reranks BM25's top 20
 * ```
 */
export function ratelOpenAIDecisionPlugin(
  config: OpenAIDecisionPluginConfig = {},
): RetrieverPlugin {
  warnOpenAIDecisionBetaOnce(config.model);
  const ranker = new OpenAiDecisionRanker(config);
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
