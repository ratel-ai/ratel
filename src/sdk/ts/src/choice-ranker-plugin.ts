// What the decision-model plugins share (ADR-0027): a native choice ranker
// (Jev, OpenAI Decisions) wrapped into the ranking functions a catalog takes,
// `retrieveFn` and `rerankerFn`. Each plugin only builds its native client.

import type { RankCandidate as NativeRankCandidate, RankedId } from "../native/index.cjs";
import type { RankFn } from "./catalog.js";
import { mapRetrieverError } from "./errors.js";

/** A model's two ranking functions, for `retrieveFn` and `rerankerFn`. */
export interface RetrieverPlugin {
  /** Rank the whole catalog: pass as `retrieveFn` with `method: "custom"`. */
  retrieve: RankFn;
  /** Rerank the first stage's top candidates: pass as `rerankerFn`. */
  rerank: RankFn;
}

/** A native choice ranker: `JevRanker`, `OpenAiDecisionRanker`. */
export interface ChoiceRanker {
  rankAsync(
    query: string,
    candidates: NativeRankCandidate[],
    topK: number,
    kind: string,
  ): Promise<RankedId[]>;
}

/** `ranker` as a plugin: one rank function for both stages, its failures as
 * {@link RetrieverError}s. */
export function choiceRankerPlugin(ranker: ChoiceRanker): RetrieverPlugin {
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
