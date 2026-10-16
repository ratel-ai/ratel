// The shared adapter (ADR-0027, ADR-0028): a native choice ranker wrapped into
// the ranking functions a catalog takes, `retrieveFn` and `rerankerFn`. Each
// vendor plugin only builds its native ranker.

import { type RankedId, type RankFn, RetrieverError, type RetrieverPlugin } from "@ratel-ai/sdk";
import { type ChoiceRankerConfig, ChoiceRanker as NativeChoiceRanker } from "../native/index.cjs";

/**
 * A ranker the adapter can wrap: the native rankers this package ships, or
 * your own object with the same method.
 */
export interface ChoiceRanker {
  /** Rank `candidates` (one kind: `"tool"`, `"skill"` or `"fact"`) for `query`, at most `topK`, best first. */
  rankAsync(
    query: string,
    candidates: { id: string; text: string }[],
    topK: number,
    kind: string,
  ): Promise<RankedId[]>;
}

/** Private NAPI→TS transport prefix — must match native `RETRIEVER_ERROR_PREFIX`. */
const RETRIEVER_ERROR_PREFIX = "RATEL_RETRIEVER_ERROR:";

/**
 * Decode the native ranker's private error envelope into the SDK's
 * {@link RetrieverError}, so a catalog's `instanceof` check sees it. Anything
 * else is returned unchanged.
 */
function mapRetrieverError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  if (!error.message.startsWith(RETRIEVER_ERROR_PREFIX)) return error;
  let parsed: unknown;
  try {
    parsed = JSON.parse(error.message.slice(RETRIEVER_ERROR_PREFIX.length));
  } catch {
    return error;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return error;
  const record = parsed as Record<string, unknown>;
  if (typeof record.code !== "string" || typeof record.message !== "string") return error;
  return new RetrieverError(record.message, record.code, {
    transient: record.transient === true,
    status: typeof record.status === "number" ? record.status : undefined,
    retryAfterSecs: typeof record.retryAfterSecs === "number" ? record.retryAfterSecs : undefined,
  });
}

/**
 * The native ranker for `vendor`, its construction failures (an unknown
 * vendor) raised as {@link RetrieverError}s like its ranking failures.
 */
export function nativeRanker(vendor: string, config?: ChoiceRankerConfig): NativeChoiceRanker {
  try {
    return new NativeChoiceRanker(vendor, config);
  } catch (error) {
    throw mapRetrieverError(error);
  }
}

/**
 * `ranker` as a plugin: one rank function for both stages, its failures as
 * {@link RetrieverError}s.
 *
 * **Experimental** — may change without a major version bump.
 */
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
